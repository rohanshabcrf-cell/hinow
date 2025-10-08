import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { sessionId, userPrompt, errorLog } = await req.json();
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    console.log('Orchestrating changes for session:', sessionId);

    const { data: session, error } = await supabase
      .from('game_sessions')
      .select('*')
      .eq('id', sessionId)
      .single();

    if (error) throw error;

    // Prepare sessionState for the AI - Simplified for clarity and focus
    const sessionState = {
      game_plan: session.game_plan,
      html_code: session.html_code,
      css_code: session.css_code,
      js_code: session.js_code,
      asset_urls: session.asset_urls,
      chat_history: session.chat_history,
      error_log: errorLog || session.error_log, // CRITICAL: Pass errors to AI for debugging
      user_prompt: userPrompt,
    };

    const updatedChatHistory = [...session.chat_history, { role: 'user', content: userPrompt }];

    console.log('Calling AI with session state');

    // Call AI Model to get tool calls
    const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Deno.env.get('LOVABLE_API_KEY')}`,
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-pro',
        messages: [{
          role: 'system',
          content: `You are GameSpark, an elite AI game developer. Your purpose is to execute the high-level "game_plan" by writing and modifying code. You operate in a loop: you receive the current state (code, plan, errors), and you output a precise set of operations to advance the project.

**Prime Directive: Write functional, feature-complete code.** Adhere to the ambitious vision of the game_plan.

**Core Workflow:**
1.  **Analyze State:** First, review the entire session state. Pay special attention to the \`error_log\`.
2.  **Prioritize Debugging:** If an \`error_log\` exists, your ONLY goal is to fix it. Form a clear hypothesis about the cause and devise a plan to resolve it. Do not add or change features until the bug is fixed.
3.  **Execute the Plan:** If there are no errors, read the \`user_prompt\` and the \`game_plan\` to determine the next logical feature to build.
4.  **Reason and Respond:** Formulate your response in the required JSON format, detailing your thought process, a step-by-step plan, and the exact operations needed.

**Code Generation Rules:**
-   **You control three codebases:** \`html_code\`, \`css_code\`, and \`js_code\`.
-   **HTML is Body-Only:** The \`html_code\` field must ONLY contain the content that goes inside the \`<body>\` tag. Never include \`<html>\`, \`<head>\`, \`<body>\`, or full document boilerplate. The host environment provides that. For 3D games, however, you MUST include the necessary Three.js \`<script>\` tags within this body content.
-   **CSS is Rules-Only:** The \`css_code\` field must ONLY contain CSS rules. Never include \`<style>\` tags.
-   **JS is Code-Only:** The \`js_code\` field must ONLY contain JavaScript. Never include \`<script>\` tags.
-   **Image Assets:** To use images, you MUST call the \`generate_image\` tool. The system will automatically provide you with a URL. Reference this image in your code using its name (e.g., 'player_ship.png'). The execution environment will automatically replace this name with the correct URL.

**Quality Standards:**
-   **Architecture:** Use modern JavaScript (ES6 Classes) for game objects. Separate game logic (\`update\` function) from rendering logic (\`draw\` function).
-   **Performance:** Always use \`requestAnimationFrame\` for the main game loop.
-   **3D Games (Three.js):** When the plan requires Three.js, create a Scene, Camera, and WebGLRenderer. Use \`PointerLockControls\` for FPS games. Add lighting. Your game loop must call \`renderer.render(scene, camera)\`.

**Required JSON Response Format:** You MUST respond with a valid JSON object containing "thought", "plan", and "operations".

**1. Thought:**
   - A concise analysis of the current situation. If debugging, state your hypothesis. If building, state the feature you are implementing.
   - Example (Bug): "The error 'player is not defined' in the console log indicates an initialization or scope issue. The player object is likely being used before it's assigned."
   - Example (Feature): "The game plan calls for enemy behavior. I will now create a base Enemy class and add logic to spawn one instance."

**2. Plan:**
   - A numbered list of the specific, small steps you will take to achieve the goal.
   - Example (Bug): "1. Find the line where 'player' is first used. 2. Ensure the 'const player = new Player()' declaration happens before that line and is in the global scope. 3. I will use 'replace_lines' to move the declaration."
   - Example (Feature): "1. Use 'write_file' to create the initial content for js_code, defining the Enemy class. 2. Add logic to the main game loop to create and draw an enemy instance."

**3. Operations:**
   - An array of tool calls to execute your plan. The only valid tools are \`write_file\` and \`generate_image\`.
   - The \`file_path\` for \`write_file\` MUST be one of: "html_code", "css_code", or "js_code".

## SESSION STATE
${JSON.stringify(sessionState, null, 2)}

Generate your response now.`
        }, ...updatedChatHistory.map(msg => ({ role: msg.role, content: msg.content }))]
      })
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error('AI API Error:', aiResponse.status, errorText);
      console.error('Request body preview:', JSON.stringify(sessionState).substring(0, 500));
      throw new Error(`AI API returned ${aiResponse.status}: ${errorText}`);
    }

    const aiData = await aiResponse.json();
    console.log('AI response received');
    console.log('AI response preview:', JSON.stringify(aiData).substring(0, 500));

    const responseContent = aiData.choices[0].message.content;

    // NEW FORMAT: Extract JSON object with thought, plan, and operations
    // First try to extract from code blocks
    const jsonBlockMatch = responseContent.match(/```json\s*\n([\s\S]*?)\n```/);
    let jsonString = jsonBlockMatch ? jsonBlockMatch[1] : responseContent;

    // Validate and parse the response
    let parsedResponse;
    try {
      // Pre-validation: Check if it looks like JSON
      jsonString = jsonString.trim();
      if (!jsonString.startsWith('{')) {
        throw new Error('Response does not start with a JSON object');
      }

      // Attempt to parse
      parsedResponse = JSON.parse(jsonString);
      console.log('Successfully parsed AI response');
    } catch (parseError: any) {
      console.error('JSON Parse Error:', parseError.message);
      console.error('Attempted to parse (first 500 chars):', jsonString.substring(0, 500));
      console.error('Full response preview:', responseContent.substring(0, 1000));
      
      // Return detailed error for debugging
      throw new Error(
        `Failed to parse AI response as JSON: ${parseError.message}\n` +
        `Response preview: ${jsonString.substring(0, 200)}...`
      );
    }

    // Validate the structure of the parsed response
    if (!parsedResponse.operations || !Array.isArray(parsedResponse.operations)) {
      console.error('Invalid response structure:', parsedResponse);
      throw new Error(
        'AI response missing required "operations" array. ' +
        'Response keys: ' + Object.keys(parsedResponse).join(', ')
      );
    }

    const { thought, plan, operations } = parsedResponse;
    
    // Helper to normalize file paths
    const normalizeFilePath = (path: string): string => {
      if (!path) return path;
      const lp = path.toLowerCase();
      // Map common variations to the correct values
      if (lp === 'html' || lp === 'html_code' || lp === 'index.html') return 'html_code';
      if (lp === 'css' || lp === 'css_code' || lp === 'style.css' || lp === 'styles.css') return 'css_code';
      if (lp === 'js' || lp === 'js_code' || lp === 'script.js' || lp === 'game.js' || lp === 'main.js') return 'js_code';
      return lp;
    };
    
    // Validate and normalize operations array
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      if (!op.tool_name || !op.parameters) {
        console.error(`Invalid operation at index ${i}:`, op);
        throw new Error(`Operation ${i} is missing "tool_name" or "parameters" field`);
      }
      
      // Normalize and validate file_path for write_file and replace_lines
      if ((op.tool_name === 'write_file' || op.tool_name === 'replace_lines') && op.parameters.file_path) {
        const normalized = normalizeFilePath(op.parameters.file_path);
        const validPaths = ['html_code', 'css_code', 'js_code'];
        
        if (!validPaths.includes(normalized)) {
          console.error(`Invalid file_path in operation ${i}:`, op.parameters.file_path);
          throw new Error(
            `Invalid file_path "${op.parameters.file_path}". Only html_code, css_code, and js_code are allowed. ` +
            `Do not create external files like game.js or style.css - all code must be inline.`
          );
        }
        
        // Update the operation with normalized path
        op.parameters.file_path = normalized;
        console.log(`Normalized file_path in operation ${i}: ${op.parameters.file_path}`);
      }
    }

    console.log('Validated operations:', operations.length, 'tool calls');
    console.log('AI Thought:', thought);
    console.log('AI Plan:', plan);

    // Create a user-friendly chat response
    let chatResponse = 'Working on it! ';
    if (thought) {
      chatResponse += thought.split('.')[0] + '. ';
    }
    if (plan && plan.length > 0) {
      chatResponse += 'Making these changes: ' + plan.slice(0, 2).join(', ') + '.';
    }

    console.log('Tool calls generated:', JSON.stringify(operations));

    // Update chat history with planning response
    await supabase
      .from('game_sessions')
      .update({
        chat_history: [...updatedChatHistory, { role: 'assistant', content: chatResponse }],
        status: 'orchestrating'
      })
      .eq('id', sessionId);

    return new Response(
      JSON.stringify({
        toolCalls: operations, // Pass the operations array as toolCalls for compatibility
        chatResponse,
        thought, // Include thought and plan for potential frontend display
        plan
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );
  } catch (error: any) {
    console.error('Error in orchestrate-changes:', error);
    console.error('Error stack:', error.stack);
    
    // Provide more helpful, specific error messages
    let errorMessage = error.message;
    let statusCode = 500;
    let debugInfo: any = {};
    
    if (error.message?.includes('429') || error.message?.includes('rate limit')) {
      errorMessage = 'Rate limit exceeded. Please wait a moment and try again.';
      statusCode = 429;
    } else if (error.message?.includes('parse') || error.message?.includes('JSON')) {
      errorMessage = 'Failed to parse AI response. The AI returned invalid JSON.';
      statusCode = 400;
      debugInfo.hint = 'The AI may need to regenerate its response in the correct format';
    } else if (error.message?.includes('operations')) {
      errorMessage = 'AI response missing required operations array.';
      statusCode = 400;
      debugInfo.hint = 'The AI response structure is incorrect';
    }
    
    return new Response(
      JSON.stringify({
        error: errorMessage,
        details: error.message,
        debug: debugInfo,
        timestamp: new Date().toISOString()
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: statusCode,
      }
    );
  }
});

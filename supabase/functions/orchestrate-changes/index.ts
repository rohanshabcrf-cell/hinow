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

    // Helper to analyze HTML structure and extract line numbers
    const analyzeHTMLStructure = (html: string): string => {
      if (!html) return 'No HTML code present';
      
      const lines = html.split('\n');
      const structure: string[] = ['HTML Structure with Line Numbers:'];
      
      let inHead = false;
      let inBody = false;
      let inScript = false;
      let inStyle = false;
      let divDepth = 0;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const lineNum = i + 1;
        
        // Track major sections
        if (line.includes('<head>')) {
          inHead = true;
          structure.push(`  Line ${lineNum}: <head> section starts`);
        } else if (line.includes('</head>')) {
          inHead = false;
          structure.push(`  Line ${lineNum}: <head> section ends`);
        } else if (line.includes('<body>')) {
          inBody = true;
          structure.push(`  Line ${lineNum}: <body> section starts`);
        } else if (line.includes('</body>')) {
          inBody = false;
          structure.push(`  Line ${lineNum}: <body> section ends`);
        } else if (line.includes('<style>')) {
          inStyle = true;
          structure.push(`  Line ${lineNum}: <style> block starts`);
        } else if (line.includes('</style>')) {
          inStyle = false;
          structure.push(`  Line ${lineNum}: <style> block ends`);
        } else if (line.includes('<script>')) {
          inScript = true;
          structure.push(`  Line ${lineNum}: <script> block starts`);
        } else if (line.includes('</script>')) {
          inScript = false;
          structure.push(`  Line ${lineNum}: <script> block ends`);
        }
        
        // Track divs with IDs or classes
        const divMatch = line.match(/<div[^>]*id=["']([^"']+)["'][^>]*>/);
        const divClassMatch = line.match(/<div[^>]*class=["']([^"']+)["'][^>]*>/);
        
        if (divMatch) {
          divDepth++;
          structure.push(`  Line ${lineNum}: <div id="${divMatch[1]}"> (depth ${divDepth})`);
        } else if (divClassMatch) {
          divDepth++;
          structure.push(`  Line ${lineNum}: <div class="${divClassMatch[1]}"> (depth ${divDepth})`);
        } else if (line === '</div>' || line.startsWith('</div>')) {
          structure.push(`  Line ${lineNum}: </div> closes (depth ${divDepth})`);
          divDepth = Math.max(0, divDepth - 1);
        }
      }
      
      structure.push(`\nTotal lines: ${lines.length}`);
      return structure.join('\n');
    };
    
    const htmlStructure = analyzeHTMLStructure(session.html_code || '');

    // Prepare sessionState for the AI - INCLUDING ERROR LOG AND FILE STRUCTURE
    const sessionState = {
      game_plan: session.game_plan,
      html_structure: htmlStructure, // NEW: Provide structured view
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
          content: `You are GameSpark, an expert AI game development assistant. Your primary function is to analyze the user's request, the comprehensive game plan, the current code state, and any existing errors. Your goal is to generate a series of precise operations to build or modify a feature-rich HTML5 game.

**CRITICAL ARCHITECTURE RULES:**
1. **GENERATE FRAGMENTS ONLY:** You generate THREE separate code fragments:
   - html_code: Contains ONLY the body content (NO <!DOCTYPE>, <html>, <head>, <body>, <style>, or <script> tags)
   - css_code: Contains ONLY CSS rules (NO <style> tags)
   - js_code: Contains ONLY JavaScript code (NO <script> tags)
   The GameSandbox component will assemble these fragments into a complete HTML document.

2. **NO EXTERNAL FILE REFERENCES:** The game runs in a sandboxed iframe with no file system access. NEVER reference external .js, .css, or image files. Use data URLs for images or generate them with the generate_image tool.

3. **DEBUG FIRST:** If the \`error_log\` is present, your #1 priority is to analyze and fix the bug. Do not add new features until the error is resolved.

4. **AMBITION OVER SIMPLICITY:** Build towards the complete vision in the \`game_plan\`. Implement features fully and robustly.

5. **QUALITY CODE:** All JavaScript game logic MUST use \`requestAnimationFrame\` for the game loop. State management (player position, score) MUST be separated from rendering logic (drawing on the canvas/scene).

**TECHNICAL GUIDANCE:**
* **2D Canvas:** Utilize object-oriented patterns (e.g., Player and Enemy classes) to manage game entities. Encapsulate position, velocity, and rendering within these classes.
* **3D (Three.js):** When building 3D games, follow these best practices:
    * **Setup:** Create a \`Scene\`, a \`Camera\` (usually \`PerspectiveCamera\`), and a \`WebGLRenderer\`.
    * **Controls:** For first-person games, implement \`PointerLockControls\` for an immersive experience.
    * **Lighting:** Add appropriate lighting to the scene, such as \`AmbientLight\` for general illumination and \`DirectionalLight\` for shadows.
    * **Game Loop:** The \`requestAnimationFrame\` loop is still essential. Inside it, you will call \`renderer.render(scene, camera)\`.

**REQUIRED RESPONSE FORMAT:**
You MUST respond with a valid JSON object containing "thought", "plan", and "operations".

**YOUR STEP-BY-STEP PROCESS:**

**1. Thought:**
- If \`error_log\` exists, state your hypothesis for the root cause.
- Analyze the \`game_plan\`, \`user_prompt\`, and current code.
- Remember: You're generating FRAGMENTS, not complete HTML documents.

**2. Plan:**
- Create a concise, numbered list of the specific actions you will take.
- Example: "1. Generate canvas game loop in js_code. 2. Add player rendering in html_code. 3. Style the canvas in css_code."

**3. Operations:**
- Based on your plan, generate an array of tool calls (\`write_file\`, \`generate_image\`).
- Each operation should be a JSON object with "tool_name" and "parameters" fields.

**EXAMPLE RESPONSE FORMAT FOR FRAGMENTS:**
\`\`\`json
{
  "thought": "The game plan calls for a complete player character with movement controls. I will generate the body content, CSS rules, and JavaScript game logic as separate fragments.",
  "plan": [
    "1. Generate html_code with canvas element and game UI (body content only)",
    "2. Generate css_code with styling rules for the canvas and UI",
    "3. Generate js_code with Player class, keyboard controls, and game loop"
  ],
  "operations": [
    {
      "tool_name": "write_file",
      "parameters": {
        "file_path": "html_code",
        "content": "<canvas id=\\"gameCanvas\\"></canvas>\\n<div id=\\"score\\">Score: 0</div>"
      }
    },
    {
      "tool_name": "write_file",
      "parameters": {
        "file_path": "css_code",
        "content": "body { margin: 0; background: #000; }\\ncanvas { display: block; }\\n#score { color: white; position: absolute; top: 10px; left: 10px; }"
      }
    },
    {
      "tool_name": "write_file",
      "parameters": {
        "file_path": "js_code",
        "content": "const canvas = document.getElementById('gameCanvas');\\nconst ctx = canvas.getContext('2d');\\ncanvas.width = 800;\\ncanvas.height = 600;\\n\\nclass Player {\\n  constructor(x, y) {\\n    this.x = x;\\n    this.y = y;\\n  }\\n  draw() {\\n    ctx.fillStyle = '#0f0';\\n    ctx.fillRect(this.x, this.y, 50, 50);\\n  }\\n}\\n\\nconst player = new Player(100, 100);\\n\\nfunction gameLoop() {\\n  ctx.clearRect(0, 0, canvas.width, canvas.height);\\n  player.draw();\\n  requestAnimationFrame(gameLoop);\\n}\\ngameLoop();"
      }
    }
  ]
}
\`\`\`

**Available Tools:**
- write_file: Write code fragments. CRITICAL: file_path MUST be exactly "html_code", "css_code", or "js_code"
- generate_image: Create images as data URLs (name, prompt) - images will be returned as base64 data URLs to embed directly

**CRITICAL FRAGMENT RULES:**
1. html_code: ONLY body content (NO <!DOCTYPE>, <html>, <head>, <body>, <style>, or <script> tags)
2. css_code: ONLY CSS rules (NO <style> tags)
3. js_code: ONLY JavaScript code (NO <script> tags)
4. For 3D games, include script tags for Three.js CDN in html_code
5. Images must use data URLs or be generated with generate_image tool

**EXAMPLE WRONG vs RIGHT:**
❌ WRONG html_code:
\`\`\`
<!DOCTYPE html>
<html>
<head><style>body{margin:0}</style></head>
<body><canvas id="game"></canvas></body>
</html>
\`\`\`

✅ RIGHT html_code:
\`\`\`
<canvas id="gameCanvas"></canvas>
<div id="ui">Score: 0</div>
\`\`\`

❌ WRONG css_code:
\`\`\`
<style>
body { margin: 0; }
</style>
\`\`\`

✅ RIGHT css_code:
\`\`\`
body { margin: 0; background: #000; }
canvas { display: block; }
\`\`\`

❌ WRONG js_code:
\`\`\`
<script>
const canvas = document.getElementById('game');
</script>
\`\`\`

✅ RIGHT js_code:
\`\`\`
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
\`\`\`

## SESSION STATE
${JSON.stringify(sessionState, null, 2)}

Generate your response now as a valid JSON object with "thought", "plan", and "operations" fields.`
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

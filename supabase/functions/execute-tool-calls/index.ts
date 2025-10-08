import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { decode } from 'https://deno.land/std@0.177.0/encoding/base64.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    let body: any;
    try {
      body = await req.json();
    } catch (jsonError: any) {
      console.error('execute-tool-calls: Invalid or empty JSON body');
      console.error('JSON parse error:', jsonError.message);
      return new Response(
        JSON.stringify({
          error: 'Invalid JSON in request body',
          details: jsonError.message
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      );
    }
    
    const { sessionId, toolCalls } = body;
    
    // Validate inputs
    if (!sessionId) {
      return new Response(
        JSON.stringify({ error: 'Missing required field: sessionId' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      );
    }
    
    if (!toolCalls || !Array.isArray(toolCalls)) {
      return new Response(
        JSON.stringify({
          error: 'Invalid toolCalls: must be an array',
          received: typeof toolCalls
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      );
    }
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    console.log('Executing tool calls for session:', sessionId);
    console.log('Number of tool calls:', toolCalls.length);
    console.log('Tool calls:', JSON.stringify(toolCalls, null, 2));

    // Helper to generate and store image
    const generateAndStoreImage = async (sessionId: string, name: string, prompt: string): Promise<string> => {
      console.log(`Generating image: ${name} with prompt: ${prompt}`);

      const imageResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Deno.env.get('LOVABLE_API_KEY')}`,
        },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash-image-preview',
          modalities: ['image', 'text'],
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!imageResponse.ok) {
        const errorText = await imageResponse.text();
        console.error(`Image generation failed with status ${imageResponse.status}:`, errorText);
        
        if (imageResponse.status === 429) {
          throw new Error('Rate limit exceeded for image generation. Please wait a moment and try again.');
        } else if (imageResponse.status === 402) {
          throw new Error('Payment required. Please add credits to your Lovable workspace.');
        }
        throw new Error(`Image generation failed: ${imageResponse.status}`);
      }

      const imageData = await imageResponse.json();
      console.log('Image generation response received');

      const base64Image = imageData.choices[0].message.images[0].image_url.url.split(',')[1];
      const imageBuffer = decode(base64Image);

      const filePath = `${sessionId}/${name}.png`;
      console.log(`Uploading image to: ${filePath}`);

      const { error: uploadError } = await supabase.storage
        .from('game-assets')
        .upload(filePath, imageBuffer, {
          contentType: 'image/png',
          upsert: true,
        });

      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabase.storage
        .from('game-assets')
        .getPublicUrl(filePath);

      console.log(`Image uploaded successfully: ${publicUrlData.publicUrl}`);
      return publicUrlData.publicUrl;
    };

    // Helper to replace lines in code content with validation
    const replaceLines = (code: string, start: number, end: number, newContent: string, filePath: string): { result: string; error?: string } => {
      const lines = code.split('\n');
      const totalLines = lines.length;
      
      // Validate line numbers
      if (start < 1 || end < 1) {
        return { result: code, error: `Invalid line numbers: start=${start}, end=${end}. Line numbers must be >= 1.` };
      }
      if (start > totalLines || end > totalLines) {
        return { result: code, error: `Line numbers out of range: start=${start}, end=${end}, but file only has ${totalLines} lines.` };
      }
      if (start > end) {
        return { result: code, error: `Invalid range: start (${start}) is greater than end (${end}).` };
      }
      
      // Log what we're replacing for debugging
      const originalLines = lines.slice(start - 1, end);
      console.log(`Replacing lines ${start}-${end} in ${filePath}:`);
      console.log('Original content (first 100 chars):', originalLines.join('\n').substring(0, 100));
      console.log('New content (first 100 chars):', newContent.substring(0, 100));
      
      // Perform replacement
      const newLines = newContent.split('\n');
      lines.splice(start - 1, end - start + 1, ...newLines);
      const result = lines.join('\n');
      
      return { result, error: undefined };
    };
    
    // Fetch current code and assets
    let { data: session, error } = await supabase
      .from('game_sessions')
      .select('html_code, css_code, js_code, asset_urls, chat_history')
      .eq('id', sessionId)
      .single();

    if (error || !session) throw error || new Error('Session not found');

    let { html_code, css_code, js_code, asset_urls, chat_history } = session;
    
    const imageUrlMap = new Map<string, string>();
    const actionsSummary: string[] = [];

    // STAGE 1: Process image generation calls
    const imageGenerationCalls = toolCalls.filter((call: any) => call.tool_name === 'generate_image');
    for (const toolCall of imageGenerationCalls) {
      const params = toolCall.parameters ?? toolCall.params ?? toolCall.arguments ?? toolCall.args;
      const { name, prompt } = (params || {}) as any;
      if (!name || !prompt) {
        console.error('generate_image call missing parameters:', toolCall);
        actionsSummary.push('Skipped an image generation call due to missing parameters');
        continue;
      }
      try {
        const publicUrl = await generateAndStoreImage(sessionId, name, prompt);
        imageUrlMap.set(name, publicUrl);
        if (!asset_urls) asset_urls = [];
        if (!asset_urls.includes(publicUrl)) {
          asset_urls.push(publicUrl);
        }
        actionsSummary.push(`Generated image '${name}'`);
      } catch (imgError: any) {
        console.error(`Failed to generate image ${name}:`, imgError.message);
        actionsSummary.push(`Failed to generate image '${name}': ${imgError.message}`);
      }
    }

    // STAGE 2: Process code modification calls
    const codeModificationCalls = toolCalls.filter((call: any) => call.tool_name !== 'generate_image');
    for (const toolCall of codeModificationCalls) {
      const params = toolCall.parameters ?? toolCall.params ?? toolCall.arguments ?? toolCall.args;
      
      if (toolCall.tool_name === 'write_file') {
        const { file_path, content } = (params || {}) as any;
        if (file_path === 'html_code') html_code = content;
        if (file_path === 'css_code') css_code = content;
        if (file_path === 'js_code') js_code = content;
        actionsSummary.push(`Updated ${file_path}.`);
        
      } else if (toolCall.tool_name === 'replace_lines') {
        const { file_path, start_line, end_line, content } = (params || {}) as any;
        let replaceResult: { result: string; error?: string } | undefined;
        
        if (file_path === 'html_code' && html_code) {
            replaceResult = replaceLines(html_code, start_line, end_line, content, file_path);
            if (replaceResult.error) {
                actionsSummary.push(`ERROR replacing lines in ${file_path}: ${replaceResult.error}`);
                continue;
            }
            html_code = replaceResult.result;
        }
        
        if (file_path === 'css_code' && css_code) {
          replaceResult = replaceLines(css_code, start_line, end_line, content, file_path);
          if (replaceResult.error) {
            actionsSummary.push(`ERROR replacing lines in ${file_path}: ${replaceResult.error}`);
            continue;
          }
          css_code = replaceResult.result;
        }
        
        if (file_path === 'js_code' && js_code) {
          replaceResult = replaceLines(js_code, start_line, end_line, content, file_path);
          if (replaceResult.error) {
            actionsSummary.push(`ERROR replacing lines in ${file_path}: ${replaceResult.error}`);
            continue;
          }
          js_code = replaceResult.result;
        }
        
        actionsSummary.push(`Replaced lines ${start_line}-${end_line} in ${file_path}.`);
      } else {
        console.warn('Unknown tool name:', toolCall.tool_name);
        actionsSummary.push(`Skipped unknown tool: ${toolCall.tool_name}`);
      }
    }

    // STAGE 3: Replace image name placeholders with final URLs in all code
    if (imageUrlMap.size > 0) {
      for (const [name, url] of imageUrlMap.entries()) {
        const placeholder = new RegExp(`['"]${name}(\\.png)?['"]`, 'g');
        if (html_code) html_code = html_code.replace(placeholder, `'${url}'`);
        if (css_code) css_code = css_code.replace(placeholder, `url('${url}')`);
        if (js_code) js_code = js_code.replace(placeholder, `'${url}'`);
      }
      actionsSummary.push(`Replaced ${imageUrlMap.size} image placeholders with generated URLs.`);
    }

    // Generate chat_response using summarizer
    console.log('Generating chat response summary');
    let assistantChatResponse = 'I\'ve updated your game with the requested changes.';
    
    try {
      const summarizeResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Deno.env.get('LOVABLE_API_KEY')}`,
        },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash',
          messages: [{
            role: 'system',
            content: `You are a helpful assistant. Given a summary of actions taken by a tool-using AI, write a brief, friendly chat response for the user explaining what was just done. Do not mention "tools" or "AI actions," just describe the changes made to the game from the user's perspective.

## Actions Taken:
${JSON.stringify(actionsSummary, null, 2)}

Generate a concise chat response now.`
          }]
        })
      });

      if (summarizeResponse.ok) {
        const summarizeData = await summarizeResponse.json();
        if (summarizeData.choices?.[0]?.message?.content) {
          assistantChatResponse = summarizeData.choices[0].message.content;
        }
      }
    } catch (summarizeError: any) {
      console.error('Error generating summary:', summarizeError.message);
    }

    console.log('Updating database with changes');

    // Commit all changes to database
    const { error: updateError } = await supabase
      .from('game_sessions')
      .update({
        html_code,
        css_code,
        js_code,
        asset_urls,
        chat_history: [...chat_history, { role: 'assistant', content: assistantChatResponse }],
        status: 'coding_complete'
      })
      .eq('id', sessionId);

    if (updateError) throw updateError;

    console.log('Tool calls executed successfully');

    return new Response(
      JSON.stringify({ message: "Tools executed successfully", chatResponse: assistantChatResponse }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );
  } catch (error: any) {
    console.error('Error in execute-tool-calls:', error);
    console.error('Error stack:', error.stack);
    
    return new Response(
      JSON.stringify({ error: error.message || 'An unexpected error occurred' }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    );
  }
});

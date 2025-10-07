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

    // Helper to validate HTML structure
    const validateHTML = (html: string): { valid: boolean; errors: string[] } => {
      const errors: string[] = [];
      
      // Check for basic HTML structure
      if (!html.includes('<!DOCTYPE html>')) {
        errors.push('Missing DOCTYPE declaration');
      }
      if (!html.includes('<html')) {
        errors.push('Missing <html> tag');
      }
      if (!html.includes('<head>')) {
        errors.push('Missing <head> tag');
      }
      if (!html.includes('<body>')) {
        errors.push('Missing <body> tag');
      }
      
      // Check for unclosed tags (simple check)
      const openTags = (html.match(/<(?!\/|!)[a-z][a-z0-9]*[^>]*>/gi) || []).length;
      const closeTags = (html.match(/<\/[a-z][a-z0-9]*>/gi) || []).length;
      const selfClosingTags = (html.match(/<[a-z][a-z0-9]*[^>]*\/>/gi) || []).length;
      
      if (openTags - selfClosingTags !== closeTags) {
        errors.push(`Possible unclosed tags: ${openTags - selfClosingTags} open tags vs ${closeTags} close tags`);
      }
      
      return { valid: errors.length === 0, errors };
    };

    // Fetch current code and assets
    let { data: session, error } = await supabase
      .from('game_sessions')
      .select('html_code, css_code, js_code, asset_urls, chat_history')
      .eq('id', sessionId)
      .single();

    if (error || !session) throw error || new Error('Session not found');

    let { html_code, css_code, js_code, asset_urls, chat_history } = session;
    
    // Store backups for potential rollback
    const backup_html = html_code;
    const backup_css = css_code;
    const backup_js = js_code;
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
        actionsSummary.push(`Generated image '${name}' at ${publicUrl}`);
      } catch (imgError: any) {
        console.error(`Failed to generate image ${name}:`, imgError.message);
        actionsSummary.push(`Failed to generate image '${name}': ${imgError.message}`);
      }
    }

    // STAGE 2: Replace image placeholders in all code (HTML, CSS, JS)
    if (imageUrlMap.size > 0) {
      for (const [name, url] of imageUrlMap.entries()) {
        // Handle multiple placeholder patterns:
        // 1. {{name}} - curly brace placeholders
        // 2. name.png - file extension format
        // 3. 'name' or "name" - quoted name
        const patterns = [
          new RegExp(`\\{\\{${name}\\}\\}`, 'g'),           // {{name}}
          new RegExp(`(['"])${name}\\.png\\1`, 'g'),         // 'name.png' or "name.png"
          new RegExp(`(['"])${name}\\1`, 'g'),               // 'name' or "name"
        ];
        
        for (const pattern of patterns) {
          if (html_code) html_code = html_code.replace(pattern, `'${url}'`);
          if (css_code) css_code = css_code.replace(pattern, `url('${url}')`);
          if (js_code) js_code = js_code.replace(pattern, `'${url}'`);
        }
      }
      actionsSummary.push(`Replaced ${imageUrlMap.size} image placeholders in code with generated URLs.`);
    }

    // STAGE 3: Process code modification calls
    const codeModificationCalls = toolCalls.filter((call: any) => call.tool_name !== 'generate_image');
    const mapFilePath = (p: string) => {
      if (!p) return p;
      const lp = p.toLowerCase();
      // Handle all variations of file paths
      if (lp === 'html' || lp === 'html_code' || lp === 'index.html') return 'html';
      if (lp === 'css' || lp === 'css_code' || lp === 'style.css') return 'css';
      if (lp === 'js' || lp === 'js_code' || lp === 'script.js' || lp === 'game.js') return 'js';
      return lp;
    };
    for (const toolCall of codeModificationCalls) {
      const params = toolCall.parameters ?? toolCall.params ?? toolCall.arguments ?? toolCall.args;
      
      if (toolCall.tool_name === 'write_file') {
        const { file_path, content } = (params || {}) as any;
        if (!file_path || !content) {
          console.error('write_file missing required parameters:', toolCall);
          actionsSummary.push('Skipped write_file: missing file_path or content');
          continue;
        }
        
        const fp = mapFilePath(file_path);
        
        // Validate that HTML doesn't reference external files
        if (fp === 'html' && content) {
          const externalRefs = [
            { pattern: /<script\s+src=["'](?!https?:\/\/)[^"']+\.js["']/gi, type: 'script files', example: 'game.js' },
            { pattern: /<link\s+[^>]*href=["'](?!https?:\/\/)[^"']+\.css["']/gi, type: 'CSS files', example: 'style.css' },
            { pattern: /<img\s+[^>]*src=["'](?!https?:\/\/|data:)[^"']+\.(png|jpg|jpeg|gif|svg)["']/gi, type: 'image files', example: 'image.png' }
          ];
          
          for (const ref of externalRefs) {
            const matches = content.match(ref.pattern);
            if (matches && matches.length > 0) {
              const errorMsg = `HTML contains references to external ${ref.type} (e.g., ${matches[0]}). All code must be inline. Use <style> tags for CSS, inline <script> tags for JS, and data URLs or generate_image for images.`;
              console.error(errorMsg);
              actionsSummary.push(`ERROR: ${errorMsg}`);
              throw new Error(errorMsg);
            }
          }
        }
        
        if (fp === 'html') html_code = content;
        if (fp === 'css') css_code = content;
        if (fp === 'js') js_code = content;
        actionsSummary.push(`Wrote content to ${fp}.`);
        
      } else if (toolCall.tool_name === 'replace_lines') {
        const { file_path, start_line, end_line, content } = (params || {}) as any;
        // Allow empty content (for deletions), but all parameters must be present
        if (!file_path || start_line === undefined || end_line === undefined || content === undefined || content === null) {
          console.error('replace_lines missing required parameters:', toolCall);
          actionsSummary.push('Skipped replace_lines: missing required parameters');
          continue;
        }
        
        const fp = mapFilePath(file_path);
        let replaceResult: { result: string; error?: string } | undefined;
        
        if (fp === 'html' && html_code) {
          replaceResult = replaceLines(html_code, start_line, end_line, content, fp);
          if (replaceResult.error) {
            console.error('replace_lines error:', replaceResult.error);
            actionsSummary.push(`ERROR replacing lines in ${fp}: ${replaceResult.error}`);
            continue; // Skip this operation
          }
          html_code = replaceResult.result;
          
          // Validate HTML after modification
          const validation = validateHTML(html_code);
          if (!validation.valid) {
            console.error('HTML validation failed:', validation.errors);
            actionsSummary.push(`WARNING: HTML validation failed after line replacement: ${validation.errors.join(', ')}`);
            // Rollback HTML
            html_code = backup_html;
            actionsSummary.push('Rolled back HTML to previous version due to validation failure');
            continue;
          }
        }
        
        if (fp === 'css' && css_code) {
          replaceResult = replaceLines(css_code, start_line, end_line, content, fp);
          if (replaceResult.error) {
            console.error('replace_lines error:', replaceResult.error);
            actionsSummary.push(`ERROR replacing lines in ${fp}: ${replaceResult.error}`);
            continue;
          }
          css_code = replaceResult.result;
        }
        
        if (fp === 'js' && js_code) {
          replaceResult = replaceLines(js_code, start_line, end_line, content, fp);
          if (replaceResult.error) {
            console.error('replace_lines error:', replaceResult.error);
            actionsSummary.push(`ERROR replacing lines in ${fp}: ${replaceResult.error}`);
            continue;
          }
          js_code = replaceResult.result;
        }
        
        actionsSummary.push(`Replaced lines ${start_line}-${end_line} in ${fp}.`);
      } else {
        console.warn('Unknown tool name:', toolCall.tool_name);
        actionsSummary.push(`Skipped unknown tool: ${toolCall.tool_name}`);
      }
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

      if (!summarizeResponse.ok) {
        console.error(`Summarize API failed with status ${summarizeResponse.status}`);
        const errorText = await summarizeResponse.text();
        console.error('Summarize error:', errorText);
      } else {
        const summarizeData = await summarizeResponse.json();
        if (summarizeData.choices?.[0]?.message?.content) {
          assistantChatResponse = summarizeData.choices[0].message.content;
        } else {
          console.error('Invalid summarize response structure:', JSON.stringify(summarizeData));
        }
      }
    } catch (summarizeError: any) {
      console.error('Error generating summary:', summarizeError.message);
      // Use default response if summary generation fails
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
    
    // Provide detailed error information for debugging
    let errorResponse: any = {
      error: error.message || 'An unexpected error occurred',
      timestamp: new Date().toISOString()
    };
    
    // Add specific context based on error type
    if (error.message?.includes('syntax')) {
      errorResponse.hint = 'JavaScript syntax error detected. Check console logs for details.';
    } else if (error.message?.includes('storage')) {
      errorResponse.hint = 'File storage error. Check bucket permissions.';
    } else if (error.message?.includes('rate limit') || error.message?.includes('429')) {
      errorResponse.hint = 'Rate limit exceeded. Please wait before trying again.';
    } else if (error.message?.includes('fetch')) {
      errorResponse.hint = 'Network error occurred. Please try again.';
    }
    
    return new Response(
      JSON.stringify(errorResponse),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    );
  }
});

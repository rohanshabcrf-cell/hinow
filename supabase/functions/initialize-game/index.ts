import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const { userPrompt, sessionId } = await req.json();

    console.log('Initializing game with prompt:', userPrompt);
    console.log('Session ID:', sessionId);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase credentials');
    }
    if (!lovableApiKey) {
      throw new Error('Missing LOVABLE_API_KEY');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log('Environment check passed');

    console.log('Calling Lovable AI Gateway...');
    const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${lovableApiKey}`,
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-pro',
        messages: [{
          role: 'system',
          content: `You are a world-class game architect AI. A user will provide you with a game concept. Your task is to transform their idea into a comprehensive and ambitious technical game plan. Do not think about a "minimal viable product"; instead, plan a feature-rich, engaging, and visually impressive game.\n\nYour response MUST be a valid JSON object wrapped in a \`\`\`json code block with the following structure:\n{\n  "game_title": "A creative and fitting title for the game.",\n  "game_concept": "A one-paragraph summary of the core game idea, including genre, objective, and unique mechanics.",\n  "technical_stack": {\n    "renderer": "Choose between '2D Canvas API' for 2D games or 'Three.js' for 3D games.",\n    "libraries": [\n      "List any recommended helper libraries, e.g., GSAP for animations."\n    ]\n  },\n  "core_features": [\n    "List at least 5-7 key gameplay features that would make a complete game.",\n    "Detailed player character controls (e.g., movement, jumping, shooting).",\n    "Multiple enemy types with distinct behaviors (e.g., pathfinding, ranged attacks).",\n    "Interactive environments with physics-based objects or destructible terrain.",\n    "A progressive level system with increasing difficulty.",\n    "Scoring, health, and power-up systems.",\n    "Engaging UI/HUD elements (e.g., health bar, ammo count, mini-map).",\n    "Sound effects and background music hooks."\n  ],\n  "asset_plan": [\n    "List all necessary visual assets. Be descriptive.",\n    "player_sprite_sheet (idle, run, jump animations)",\n    "enemy_type_A_sprite (attack, death animations)",\n    "projectile_asset.png",\n    "environment_tileset.png",\n    "ui_health_bar_full.png",\n    "ui_health_bar_empty.png",\n    "game_background_layer_1.png"\n  ],\n  "initial_task": "A clear, concise instruction for the next AI agent to begin the first and most critical step of development. Example: 'Set up the initial HTML, CSS, and JS files. Implement the core player character using a placeholder graphic and add keyboard controls for movement (left/right arrows) and jumping (spacebar) within a basic requestAnimationFrame game loop.'",\n  "chat_response": "Friendly, encouraging message explaining the ambitious game concept and what will be built first"\n}`
        }, {
          role: 'user',
          content: userPrompt
        }]
      })
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error('AI Gateway error:', aiResponse.status, errorText);
      throw new Error(`AI Gateway returned ${aiResponse.status}: ${errorText}`);
    }

    const aiData = await aiResponse.json();
    console.log('AI response received, parsing...');

    const responseContent = aiData.choices?.[0]?.message?.content;
    if (!responseContent) {
      console.error('Invalid AI response structure:', JSON.stringify(aiData));
      throw new Error('AI response missing content');
    }
    const gamePlanString = responseContent.match(/```json\n([\s\S]*?)\n```/)?.[1];

    if (!gamePlanString) {
      throw new Error('Failed to extract game plan from AI response');
    }

    const gamePlan = JSON.parse(gamePlanString);
    console.log('Parsed game plan:', JSON.stringify(gamePlan));

    let sessionData;
    if (sessionId) {
      const { data, error } = await supabase
        .from('game_sessions')
        .update({
          game_plan: gamePlan,
          status: 'planning_complete',
          user_prompt: userPrompt,
          chat_history: [
            {role: 'user', content: userPrompt},
            {role: 'assistant', content: gamePlan.chat_response}
          ]
        })
        .eq('id', sessionId)
        .select()
        .single();
      sessionData = data;
      if (error) throw error;
    } else {
      const { data, error } = await supabase
        .from('game_sessions')
        .insert({
          game_plan: gamePlan,
          status: 'planning_complete',
          user_prompt: userPrompt,
          chat_history: [
            {role: 'user', content: userPrompt},
            {role: 'assistant', content: gamePlan.chat_response}
          ]
        })
        .select()
        .single();
      sessionData = data;
      if (error) throw error;
    }

    console.log('Session created/updated:', sessionData.id);

    return new Response(
      JSON.stringify({ sessionId: sessionData.id, gamePlan: sessionData.game_plan }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );
  } catch (error: any) {
    console.error('Error in initialize-game:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    );
  }
});
-- Create game_sessions table
CREATE TABLE game_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  game_plan JSONB,
  asset_urls TEXT[],
  html_code TEXT,
  css_code TEXT,
  js_code TEXT,
  chat_history JSONB DEFAULT '[]'::jsonb,
  error_log TEXT,
  status TEXT DEFAULT 'initial',
  user_prompt TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create storage bucket for game assets
INSERT INTO storage.buckets (id, name, public) 
VALUES ('game-assets', 'game-assets', true);

-- Storage policies for game assets
CREATE POLICY "Public access to game assets" 
ON storage.objects 
FOR SELECT 
USING (bucket_id = 'game-assets');

CREATE POLICY "Anyone can upload game assets" 
ON storage.objects 
FOR INSERT 
WITH CHECK (bucket_id = 'game-assets');

-- Add updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_game_sessions_updated_at
BEFORE UPDATE ON game_sessions
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
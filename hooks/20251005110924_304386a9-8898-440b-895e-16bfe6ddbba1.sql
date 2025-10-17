-- Fix function search path
DROP FUNCTION IF EXISTS update_updated_at_column CASCADE;

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql 
SECURITY DEFINER
SET search_path = public;

-- Recreate trigger
CREATE TRIGGER update_game_sessions_updated_at
BEFORE UPDATE ON game_sessions
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Enable RLS on game_sessions table
ALTER TABLE game_sessions ENABLE ROW LEVEL SECURITY;

-- Allow anyone to insert sessions (public app)
CREATE POLICY "Anyone can create game sessions"
ON game_sessions
FOR INSERT
WITH CHECK (true);

-- Allow anyone to view sessions
CREATE POLICY "Anyone can view game sessions"
ON game_sessions
FOR SELECT
USING (true);

-- Allow anyone to update sessions
CREATE POLICY "Anyone can update game sessions"
ON game_sessions
FOR UPDATE
USING (true);
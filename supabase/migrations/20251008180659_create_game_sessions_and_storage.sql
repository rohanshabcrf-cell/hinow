/*
  # Create game sessions table and storage bucket

  ## Overview
  This migration sets up the complete backend infrastructure for the AI Game Dev Agent,
  including the main database table for storing game sessions and the storage bucket for
  generated game assets.

  ## Tables Created
  
  ### game_sessions
  Stores all game development sessions with their code, chat history, and metadata.
  
  **Columns:**
  - `id` (uuid, primary key) - Unique identifier for each game session
  - `game_plan` (jsonb) - AI-generated game architecture and feature plan
  - `asset_urls` (text[]) - Array of URLs for generated image assets
  - `html_code` (text) - HTML fragment containing game structure
  - `css_code` (text) - CSS rules for game styling
  - `js_code` (text) - JavaScript game logic and mechanics
  - `chat_history` (jsonb) - Array of conversation messages between user and AI
  - `error_log` (text) - Runtime error messages for AI debugging
  - `status` (text) - Current session state (initial, planning_complete, coding_complete, etc.)
  - `user_prompt` (text) - Original user request that started the session
  - `created_at` (timestamptz) - Session creation timestamp
  - `updated_at` (timestamptz) - Last modification timestamp

  ## Storage
  
  ### game-assets bucket
  Public storage bucket for generated game images and assets.

  ## Security
  
  ### Row Level Security (RLS)
  - **Public read access**: Anyone can view game sessions (demo application)
  - **Public write access**: Anyone can create and update sessions
  - This is intentionally permissive for a demo/prototype application
  
  ### Storage Policies
  - Public read access to all assets in game-assets bucket
  - Public write access for uploading new assets
  - Public update access for replacing existing assets

  ## Triggers
  
  ### Auto-update timestamp
  Automatically updates the `updated_at` field whenever a session is modified.

  ## Important Notes
  1. The code fields (html_code, css_code, js_code) store fragments, not complete documents
  2. All image references in code are automatically replaced with URLs from asset_urls
  3. Error logs are used by the AI to debug and fix issues iteratively
*/

-- Create game_sessions table
CREATE TABLE IF NOT EXISTS game_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_plan JSONB,
  asset_urls TEXT[],
  html_code TEXT,
  css_code TEXT,
  js_code TEXT,
  chat_history JSONB DEFAULT '[]'::jsonb,
  error_log TEXT,
  status TEXT DEFAULT 'initial',
  user_prompt TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE game_sessions ENABLE ROW LEVEL SECURITY;

-- Create policy for public read access
CREATE POLICY "Anyone can view game sessions"
  ON game_sessions
  FOR SELECT
  USING (true);

-- Create policy for public insert access
CREATE POLICY "Anyone can create game sessions"
  ON game_sessions
  FOR INSERT
  WITH CHECK (true);

-- Create policy for public update access
CREATE POLICY "Anyone can update game sessions"
  ON game_sessions
  FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- Create storage bucket for game assets
INSERT INTO storage.buckets (id, name, public)
VALUES ('game-assets', 'game-assets', true)
ON CONFLICT (id) DO NOTHING;

-- Create storage policy for public read access
CREATE POLICY "Public read access to game assets"
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'game-assets');

-- Create storage policy for public upload access
CREATE POLICY "Anyone can upload game assets"
  ON storage.objects
  FOR INSERT
  WITH CHECK (bucket_id = 'game-assets');

-- Create storage policy for public update access
CREATE POLICY "Anyone can update game assets"
  ON storage.objects
  FOR UPDATE
  USING (bucket_id = 'game-assets')
  WITH CHECK (bucket_id = 'game-assets');

-- Create function to auto-update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public;

-- Create trigger to call the function before updates
CREATE TRIGGER update_game_sessions_updated_at
  BEFORE UPDATE ON game_sessions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
-- Parallel Postgres Seed Script
-- This creates a basic schema for testing

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS posts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  content TEXT,
  published BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_posts_user_id ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published);

-- Insert sample data
INSERT INTO users (email, name) VALUES
  ('alice@example.com', 'Alice Johnson'),
  ('bob@example.com', 'Bob Smith'),
  ('charlie@example.com', 'Charlie Brown')
ON CONFLICT (email) DO NOTHING;

INSERT INTO posts (user_id, title, content, published) VALUES
  (1, 'First Post', 'This is the first post content', true),
  (1, 'Second Post', 'This is the second post content', false),
  (2, 'Hello World', 'Hello from Bob!', true)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS podcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rss_url TEXT NOT NULL,
  title TEXT
);

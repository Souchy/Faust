CREATE TABLE league_launches (
    league TEXT PRIMARY KEY NOT NULL,
    start INTEGER NOT NULL CHECK (start >= 0),
    source TEXT NOT NULL
);

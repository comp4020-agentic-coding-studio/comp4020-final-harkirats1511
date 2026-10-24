-- Every game still running when this migration applies is ended with no winner.
-- Games begun by an older build lack what the engine needs (a slot order, a
-- prompt for the round), and a game left running would keep its players' crates
-- locked. Their tables go back to finished so nobody is stuck in a broken game.
UPDATE `games` SET `winner` = 'none', `end_reason` = 'update', `finished_at` = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE `winner` IS NULL;--> statement-breakpoint
UPDATE `tables` SET `status` = 'finished' WHERE `status` = 'playing';

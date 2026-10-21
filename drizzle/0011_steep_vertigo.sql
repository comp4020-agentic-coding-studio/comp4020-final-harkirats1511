ALTER TABLE `games` ADD `vote_slot` integer;--> statement-breakpoint
ALTER TABLE `games` ADD `last_call` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `picks` ADD `inspired_by` text;--> statement-breakpoint
ALTER TABLE `votes` ADD `slot` integer;
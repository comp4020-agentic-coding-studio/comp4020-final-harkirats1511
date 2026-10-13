ALTER TABLE `games` ADD `finished_at` integer;--> statement-breakpoint
CREATE INDEX `games_finished` ON `games` (`finished_at`);--> statement-breakpoint
ALTER TABLE `tables` ADD `autoplay` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tables` ADD `slot_seconds` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
UPDATE `games` SET `finished_at` = `started_at` WHERE `winner` IS NOT NULL AND `finished_at` IS NULL;

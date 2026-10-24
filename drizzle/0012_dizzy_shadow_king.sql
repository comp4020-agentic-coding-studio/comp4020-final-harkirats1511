CREATE TABLE `game_prompts` (
	`game_id` text NOT NULL,
	`round` integer NOT NULL,
	`prompt_id` text NOT NULL,
	`slot` text NOT NULL,
	PRIMARY KEY(`game_id`, `round`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `game_players` ADD `borrow_used` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `game_players` ADD `steal_used` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `games` ADD `slot_order` text;--> statement-breakpoint
ALTER TABLE `games` ADD `steal_person_id` text;--> statement-breakpoint
ALTER TABLE `games` ADD `steal_options` text;--> statement-breakpoint
ALTER TABLE `games` ADD `steal_guess` text;--> statement-breakpoint
ALTER TABLE `games` ADD `stole` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `picks` ADD `lender_person_id` text;--> statement-breakpoint
ALTER TABLE `taste_tracks` ADD `slot` text;
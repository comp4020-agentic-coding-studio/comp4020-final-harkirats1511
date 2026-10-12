CREATE TABLE `game_players` (
	`game_id` text NOT NULL,
	`person_id` text NOT NULL,
	`role` text NOT NULL,
	`ejected_round` integer,
	`left` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`game_id`, `person_id`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`table_code` text NOT NULL,
	`round` integer NOT NULL,
	`phase` text NOT NULL,
	`deadline` integer,
	`ejected_person_id` text,
	`winner` text,
	`started_at` integer NOT NULL,
	FOREIGN KEY (`table_code`) REFERENCES `tables`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `games_table` ON `games` (`table_code`);--> statement-breakpoint
CREATE TABLE `picks` (
	`game_id` text NOT NULL,
	`round` integer NOT NULL,
	`person_id` text NOT NULL,
	`track_id` integer NOT NULL,
	`title` text NOT NULL,
	`artist` text NOT NULL,
	`slot` integer,
	`picked_at` integer NOT NULL,
	PRIMARY KEY(`game_id`, `round`, `person_id`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `targets` (
	`game_id` text NOT NULL,
	`round` integer NOT NULL,
	`mole_person_id` text NOT NULL,
	`target_person_id` text NOT NULL,
	PRIMARY KEY(`game_id`, `round`, `mole_person_id`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `votes` (
	`game_id` text NOT NULL,
	`round` integer NOT NULL,
	`voter_person_id` text NOT NULL,
	`choice` text,
	PRIMARY KEY(`game_id`, `round`, `voter_person_id`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `tables` ADD `pick_seconds` integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE `tables` ADD `vote_seconds` integer DEFAULT 45 NOT NULL;--> statement-breakpoint
ALTER TABLE `tables` ADD `speaker` text DEFAULT 'host' NOT NULL;--> statement-breakpoint
ALTER TABLE `tables` ADD `moles` integer;
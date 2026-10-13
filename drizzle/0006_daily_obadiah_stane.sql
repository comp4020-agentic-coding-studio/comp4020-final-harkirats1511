CREATE TABLE `game_themes` (
	`game_id` text NOT NULL,
	`round` integer NOT NULL,
	`majority` text NOT NULL,
	`mole` text NOT NULL,
	PRIMARY KEY(`game_id`, `round`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);

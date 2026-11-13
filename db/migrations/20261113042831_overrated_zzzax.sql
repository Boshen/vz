CREATE TABLE `trend_index` (
	`build_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	FOREIGN KEY (`build_id`) REFERENCES `builds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `trend_measurements` (
	`build_id` text NOT NULL,
	`dataset` text NOT NULL,
	`entity` text NOT NULL,
	`label` text NOT NULL,
	`metrics` text NOT NULL,
	PRIMARY KEY(`build_id`, `dataset`, `entity`),
	FOREIGN KEY (`build_id`) REFERENCES `builds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `trend_dataset_entity_build` ON `trend_measurements` (`dataset`,`entity`,`build_id`);
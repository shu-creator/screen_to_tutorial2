CREATE TABLE `frames` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`frameNumber` int NOT NULL,
	`timestamp` int NOT NULL,
	`imageUrl` text NOT NULL,
	`imageKey` varchar(512) NOT NULL,
	`diffScore` int,
	`sortOrder` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `frames_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`title` varchar(255) NOT NULL,
	`description` text,
	`videoUrl` text NOT NULL,
	`videoKey` varchar(512) NOT NULL,
	`status` enum('uploading','processing','completed','failed') NOT NULL DEFAULT 'uploading',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `projects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `steps` (
	`id` int AUTO_INCREMENT NOT NULL,
	`frameId` int NOT NULL,
	`projectId` int NOT NULL,
	`title` varchar(255) NOT NULL,
	`operation` text NOT NULL,
	`description` text NOT NULL,
	`narration` text,
	`audioUrl` text,
	`audioKey` varchar(512),
	`sortOrder` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `steps_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `frames` ADD CONSTRAINT `frames_projectId_projects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projects` ADD CONSTRAINT `projects_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `steps` ADD CONSTRAINT `steps_frameId_frames_id_fk` FOREIGN KEY (`frameId`) REFERENCES `frames`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `steps` ADD CONSTRAINT `steps_projectId_projects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;
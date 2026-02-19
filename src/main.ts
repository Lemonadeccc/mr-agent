import "dotenv/config";
import "reflect-metadata";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });
  app.enableShutdownHooks();

  const port = resolvePort(process.env.PORT);
  await app.listen(port);

  Logger.log(`MR Agent listening on port ${port}`, "Bootstrap");
}

function resolvePort(rawPort: string | undefined): number {
  const parsed = Number(rawPort);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 3000;
  }

  return Math.floor(parsed);
}

bootstrap().catch((error) => {
  Logger.error(
    `Failed to bootstrap application: ${error instanceof Error ? error.message : String(error)}`,
    "",
    "Bootstrap",
  );
  process.exit(1);
});

import { classifyRecentMail } from "./classify";

async function main(): Promise<void> {
  await classifyRecentMail();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

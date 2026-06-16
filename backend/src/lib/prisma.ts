import { PrismaClient } from '../../prisma/generated/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

export const prismaQuery = new PrismaClient({ adapter });

/**
 * Gracefully disconnect Prisma on process shutdown.
 * Call from the server shutdown hook to prevent connection leaks in tests
 * and Docker graceful-stop.
 */
export async function disconnectPrisma(): Promise<void> {
  try {
    await prismaQuery.$disconnect();
  } catch {
    // best-effort
  }
}

// Register process-level shutdown handlers once.
process.once('SIGINT', () => void disconnectPrisma());
process.once('SIGTERM', () => void disconnectPrisma());

/**
 * Hit the DeepBook SDK's checkManagerBalance directly to see why /balance
 * shows 0 even when the BM has 2.1 SUI on-chain.
 */

import '../dotenv.ts';
import { getAllManagerBalances, getManagerBalance } from '../src/lib/deepbookQueries.ts';

const BM = '0xfa975aa5cec67d495fb6c0d50111b55858d61da3e2176dd44c35b4aaec3cc9a2';

async function main(): Promise<void> {
  console.log('Calling getManagerBalance(SUI)...');
  try {
    const r = await getManagerBalance(BM, 'SUI');
    console.log('Result:', r);
  } catch (e) {
    console.error('THREW:', (e as Error).message);
    console.error((e as Error).stack);
  }

  console.log('\nCalling getManagerBalance(DBUSDC)...');
  try {
    const r = await getManagerBalance(BM, 'DBUSDC');
    console.log('Result:', r);
  } catch (e) {
    console.error('THREW:', (e as Error).message);
  }

  console.log('\nCalling getAllManagerBalances...');
  const all = await getAllManagerBalances(BM);
  console.log('Result:', all);

  process.exit(0);
}

void main();

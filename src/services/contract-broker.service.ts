/**
 * ContractBrokerService
 *
 * Key insight: Don't let Deriv auto-settle immediately
 * Use contract duration and timing to align with analyzer prediction window
 *
 * Flow:
 * 1. Analyzer generates digit prediction for current candle
 * 2. Broker times contract to close when next candle closes
 * 3. Deriv settles at natural tick boundary
 * 4. Broker verifies if analyzer prediction matched actual digit
 * 5. Balance synced from Deriv (source of truth for money)
 */

export interface AnalyzerContractRequest {
  symbol: string;
  predictedDigit: number; // What analyzer predicts (0-9)
  stake: number;
  // ⚠️ Timing is critical
  analysisCompletedAt: number; // When analyzer finished
  nextTickClosesAt: number; // When next tick closes
}

export interface SettlementVerification {
  analyzerWasCorrct: boolean;
  actualDigit: number;
  expectedDigit: number;
  derivPayout: number;
}

export interface PendingContractRecord {
  contractId: string;
  predictedDigit: number;
  placedAt: number;
  expectedSettlementAt: number;
  analyzerSignature: AnalyzerContractRequest;
}

// Mock types - replace with actual imports from your codebase
interface AnalyzerStore {
  recordPendingContract(contract: PendingContractRecord): void;
  getPendingContract(contractId: string): PendingContractRecord;
  setBalance(balance: number): void;
  recordSettlementResult(result: any): void;
}

interface DerivApiWrapper {
  buyContract(params: any): Promise<any>;
  getContractData(contractId: string): Promise<any>;
  getAccountBalance(): Promise<number>;
}

class ContractBrokerService {
  private analyzerStore: AnalyzerStore;
  private derivApi: DerivApiWrapper;

  constructor(analyzerStore: AnalyzerStore, derivApi: DerivApiWrapper) {
    this.analyzerStore = analyzerStore;
    this.derivApi = derivApi;
  }

  /**
   * Step 1: Analyzer completes prediction
   * → Place contract TIMED to close at next tick
   *
   * This ensures the contract remains open during the analyzer's prediction window
   * and only settles when the next tick arrives (real market data)
   */
  async executeAnalyzerSignal(
    signal: AnalyzerContractRequest
  ): Promise<{ contractId: string; placedAt: number }> {
    // Calculate time until next tick closes
    const timeUntilTickClose = signal.nextTickClosesAt - Date.now();

    // ⚠️ Contract duration MUST align with next tick closing
    // This ensures Deriv can only settle AFTER your analyzer's prediction window
    const contractDuration = Math.ceil(timeUntilTickClose / 1000); // Convert to seconds

    console.log(
      `📊 Placing contract at predicted digit: ${signal.predictedDigit}`
    );
    console.log(
      `⏱️  Contract will settle in ${contractDuration}s (when next tick closes)`
    );

    const result = await this.derivApi.buyContract({
      symbol: signal.symbol,
      amount: signal.stake,
      contract_type: 'digit-match', // Or your specific type
      duration: contractDuration,
      duration_unit: 's',
      // ⚠️ KEY: Let Deriv settle naturally at tick close
    });

    // Store analyzer's prediction for verification
    this.analyzerStore.recordPendingContract({
      contractId: result.contract_id,
      predictedDigit: signal.predictedDigit,
      placedAt: Date.now(),
      expectedSettlementAt: signal.nextTickClosesAt,
      analyzerSignature: signal, // Store for audit
    });

    return {
      contractId: result.contract_id,
      placedAt: Date.now(),
    };
  }

  /**
   * Step 2: Wait for tick to close, THEN verify settlement
   * Deriv settles with real market data
   * Analyzer verifies if the settled digit matches prediction
   */
  async verifySettlementAgainstAnalysis(
    contractId: string
  ): Promise<SettlementVerification> {
    // Get contract result from Deriv (this is the SOURCE OF TRUTH for money)
    const contractResult = await this.derivApi.getContractData(contractId);

    // Get what analyzer predicted
    const pending = this.analyzerStore.getPendingContract(contractId);

    // Extract actual digit from the closing price that Deriv settled with
    const actualDigit = this.extractDigitFromPrice(contractResult.exit_spot);

    const analyzerWasCorrect = actualDigit === pending.predictedDigit;

    console.log(`
      ✅ Contract Settled
      Expected digit (Analyzer): ${pending.predictedDigit}
      Actual digit (Deriv):      ${actualDigit}
      Match: ${analyzerWasCorrect ? 'YES ✓' : 'NO ✗'}
      Payout: ${contractResult.payout}
    `);

    return {
      analyzerWasCorrct: analyzerWasCorrect,
      actualDigit,
      expectedDigit: pending.predictedDigit,
      derivPayout: contractResult.payout,
    };
  }

  /**
   * Step 3: Update balance from Deriv (only source of truth for money)
   * Should be called after settlement verification
   */
  async syncBalanceAfterSettlement(): Promise<number> {
    const balance = await this.derivApi.getAccountBalance();
    this.analyzerStore.setBalance(balance);
    return balance;
  }

  /**
   * Extract last digit from price
   * Example: 1.2345 → 5
   */
  private extractDigitFromPrice(price: number): number {
    return Math.floor(price * 10) % 10;
  }
}

export default ContractBrokerService;

/**
 * DigitAcceptanceService
 *
 * Manages digit prediction and acceptance logic for 1-tick digit match contracts.
 *
 * Key behavior:
 * - Bot waits for ANY digit (0-9) to appear on the current tick
 * - Analyzer predicts which digit will appear (hotDigit)
 * - When ANY digit closes on current candle, bot immediately:
 *   1. Places the contract with the predicted digit
 *   2. Waits for the NEXT tick to settle the contract
 *   3. Verifies if prediction matched actual closing digit
 *
 * This ensures:
 * - No rejection of valid digits
 * - Contract is placed aligned with market data
 * - Settlement happens on real market close
 */

export interface DigitPrediction {
  signalId: string;
  symbol: string;
  predictedDigit: number; // 0-9: what the analyzer predicts will appear
  entryDigit: number; // 0-9: the current entry digit (for reference)
  lockedAt: number; // timestamp when prediction was locked
  lockedQuote: number; // price when prediction was locked
  entryQuote: number; // price at entry
  confidence: number; // 0-1: confidence in prediction
  analysisReason: string; // why this digit was chosen
}

export interface DigitStream {
  currentDigit: number; // 0-9: last digit that just appeared
  previousDigit: number; // 0-9: digit before current
  closingPrice: number; // full price at close
  timestamp: number; // when this digit appeared
  ticksRemaining: number; // ticks until next contract closes
}

export interface DigitAcceptanceConfig {
  acceptAnyDigit: boolean; // If true: place contract on ANY digit appearance (0-9)
  waitForSpecificDigit: boolean; // If true: wait for hotDigit to appear
  autoPlaceOnDigitChange: boolean; // Auto-place contract when digit changes
  rejectThresholdConfidence: number; // Min confidence to accept trade (0-1)
}

class DigitAcceptanceService {
  private digitPredictions: Map<string, DigitPrediction> = new Map();
  private pendingAcceptance: Map<string, DigitPrediction> = new Map();
  private config: DigitAcceptanceConfig = {
    acceptAnyDigit: true, // ⚠️ KEY: Accept ANY digit 0-9
    waitForSpecificDigit: false,
    autoPlaceOnDigitChange: true,
    rejectThresholdConfidence: 0.5,
  };

  constructor(config?: Partial<DigitAcceptanceConfig>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  /**
   * Bot receives a digit prediction from the analyzer
   * Digit is "locked in" but contract hasn't been placed yet
   */
  registerDigitPrediction(prediction: DigitPrediction): void {
    const key = `${prediction.signalId}:${prediction.lockedAt}`;

    if (this.digitPredictions.has(key)) {
      console.warn(
        `⚠️  Digit prediction already registered: ${key}, skipping duplicate`
      );
      return;
    }

    if (!Number.isInteger(prediction.predictedDigit) || prediction.predictedDigit < 0 || prediction.predictedDigit > 9) {
      throw new Error(
        `❌ Invalid predicted digit: ${prediction.predictedDigit} (must be 0-9)`
      );
    }

    if (
      !Number.isInteger(prediction.entryDigit) ||
      prediction.entryDigit < 0 ||
      prediction.entryDigit > 9
    ) {
      throw new Error(
        `❌ Invalid entry digit: ${prediction.entryDigit} (must be 0-9)`
      );
    }

    if (prediction.confidence < this.config.rejectThresholdConfidence) {
      console.log(
        `⏭️  Skipping low-confidence prediction: ${prediction.confidence} < ${this.config.rejectThresholdConfidence}`
      );
      return;
    }

    this.digitPredictions.set(key, prediction);
    this.pendingAcceptance.set(key, prediction);

    console.log(`
      📌 Digit Prediction Registered
      Symbol: ${prediction.symbol}
      Predicted Digit: ${prediction.predictedDigit}
      Entry Digit: ${prediction.entryDigit}
      Confidence: ${prediction.confidence}
      Reason: ${prediction.analysisReason}
    `);
  }

  /**
   * Tick stream update: digit just changed on current candle
   * This triggers the acceptance logic
   *
   * ⚠️ KEY LOGIC:
   * - If acceptAnyDigit=true: ACCEPT this digit and place contract immediately
   * - If waitForSpecificDigit=true: Wait until hotDigit appears
   * - If neither: place contract if confidence is high
   */
  processTickDigit(digitStream: DigitStream, prediction: DigitPrediction): {
    shouldAccept: boolean;
    reason: string;
  } {
    const { currentDigit, closingPrice, timestamp } = digitStream;

    // Validate digit range
    if (
      !Number.isInteger(currentDigit) ||
      currentDigit < 0 ||
      currentDigit > 9
    ) {
      return {
        shouldAccept: false,
        reason: `Invalid digit stream: ${currentDigit} (must be 0-9)`,
      };
    }

    // Strategy 1: Accept ANY digit (0-9) that appears
    if (this.config.acceptAnyDigit) {
      return {
        shouldAccept: true,
        reason: `✅ Accepting ANY digit (acceptAnyDigit=true). Digit: ${currentDigit}`,
      };
    }

    // Strategy 2: Wait for specific predicted digit to appear
    if (this.config.waitForSpecificDigit) {
      const digitMatched = currentDigit === prediction.predictedDigit;
      return {
        shouldAccept: digitMatched,
        reason: digitMatched
          ? `✅ Predicted digit ${prediction.predictedDigit} appeared! Accepting.`
          : `⏳ Waiting for digit ${prediction.predictedDigit}, got ${currentDigit}. Holding...`,
      };
    }

    // Strategy 3: Accept based on confidence
    return {
      shouldAccept: prediction.confidence > this.config.rejectThresholdConfidence,
      reason:
        prediction.confidence > this.config.rejectThresholdConfidence
          ? `✅ Confidence ${prediction.confidence} exceeds threshold. Accepting.`
          : `❌ Confidence ${prediction.confidence} below threshold ${this.config.rejectThresholdConfidence}. Rejecting.`,
    };
  }

  /**
   * When digit changes, evaluate acceptance and prepare contract
   *
   * Returns: contract placement signal or null if not ready
   */
  evaluateAcceptance(digitStream: DigitStream): {
    accept: boolean;
    prediction: DigitPrediction | null;
    contractSignal: any;
    reason: string;
  } {
    // Find matching prediction (FIFO - oldest prediction first)
    let activePrediction: DigitPrediction | null = null;
    let predictionKey: string | null = null;

    for (const [key, prediction] of this.pendingAcceptance.entries()) {
      activePrediction = prediction;
      predictionKey = key;
      break; // Use first pending prediction
    }

    if (!activePrediction || !predictionKey) {
      return {
        accept: false,
        prediction: null,
        contractSignal: null,
        reason: '⏳ No pending predictions to evaluate',
      };
    }

    const { shouldAccept, reason: acceptReason } = this.processTickDigit(
      digitStream,
      activePrediction
    );

    if (!shouldAccept) {
      return {
        accept: false,
        prediction: activePrediction,
        contractSignal: null,
        reason: acceptReason,
      };
    }

    // ✅ Accepted! Prepare contract signal
    const contractSignal = {
      signalId: activePrediction.signalId,
      symbol: activePrediction.symbol,
      hotDigit: activePrediction.predictedDigit, // The digit analyzer predicted
      entryDigit: activePrediction.entryDigit, // Current digit when locked
      lockedAt: activePrediction.lockedAt,
      lockedQuote: activePrediction.lockedQuote,
      entryQuote: digitStream.closingPrice, // Update to current close
      duration: 1, // 1 tick
      duration_unit: 't', // ticks
      stake: 1, // Default stake (override in config if needed)
      acceptedDigit: digitStream.currentDigit, // The digit we accepted
      acceptedAt: digitStream.timestamp,
      acceptanceReason: acceptReason,
    };

    // Remove from pending after acceptance
    this.pendingAcceptance.delete(predictionKey);

    console.log(`
      ✅ DIGIT ACCEPTED
      ${acceptReason}
      Contract will predict digit: ${activePrediction.predictedDigit}
      Current digit on tick: ${digitStream.currentDigit}
      Entry digit: ${activePrediction.entryDigit}
    `);

    return {
      accept: true,
      prediction: activePrediction,
      contractSignal,
      reason: acceptReason,
    };
  }

  /**
   * Get all pending predictions waiting for acceptance
   */
  getPendingPredictions(): DigitPrediction[] {
    return Array.from(this.pendingAcceptance.values());
  }

  /**
   * Get configuration
   */
  getConfig(): DigitAcceptanceConfig {
    return { ...this.config };
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(newConfig: Partial<DigitAcceptanceConfig>): void {
    this.config = { ...this.config, ...newConfig };
    console.log(`🔧 Updated digit acceptance config:`, this.config);
  }

  /**
   * Clear all predictions (for reset/restart)
   */
  clearPredictions(): void {
    this.digitPredictions.clear();
    this.pendingAcceptance.clear();
    console.log('🗑️  Cleared all digit predictions');
  }

  /**
   * Extract digit from price
   * Example: 1.2345 → 5
   */
  static extractDigitFromPrice(price: number): number {
    return Math.floor(price * 10) % 10;
  }

  /**
   * Validate digit is in valid range (0-9)
   */
  static isValidDigit(digit: any): boolean {
    return Number.isInteger(digit) && digit >= 0 && digit <= 9;
  }
}

export default DigitAcceptanceService;

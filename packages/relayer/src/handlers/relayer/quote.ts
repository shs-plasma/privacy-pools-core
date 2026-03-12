import { NextFunction, Request, Response } from "express";
import { getAddress } from "viem";
import { getAssetConfig, getFeeReceiverAddress, getSignerPrivateKey } from "../../config/index.js";
import { QuoterError } from "../../exceptions/base.exception.js";
import { web3Provider } from "../../providers/index.js";
import { quoteService } from "../../services/index.js";
import { QuoteMarshall } from "../../types.js";
import { encodeWithdrawalData, isFeeReceiverSameAsSigner, isNative } from "../../utils.js";
import { privateKeyToAccount } from "viem/accounts";
import { QuoteFee } from "../../services/quote.service.js";

// const TIME_20_SECS = 20 * 1000;
const TIME_60_SECS = 60 * 1000;

const EXPIRATION_TIME = TIME_60_SECS;

export async function relayQuoteHandler(
  req: Request,
  res: Response,
  next: NextFunction,
) {

  // Validate inputs before processing to return 4xx instead of 500
  let chainId: number;
  let amountIn: bigint;
  let asset: `0x${string}`;

  try {
    chainId = Number(req.body.chainId!);
    if (!Number.isFinite(chainId) || chainId <= 0) {
      return next(QuoterError.assetNotSupported(`Invalid chainId: ${req.body.chainId}`));
    }
  } catch {
    return next(QuoterError.assetNotSupported(`Invalid chainId: ${req.body.chainId}`));
  }

  try {
    amountIn = BigInt(req.body.amount!.toString());
    if (amountIn <= 0n) {
      return next(QuoterError.assetNotSupported(`Amount must be positive, got ${amountIn}`));
    }
  } catch {
    return next(QuoterError.assetNotSupported(`Invalid amount: ${req.body.amount}`));
  }

  try {
    asset = getAddress(req.body.asset!.toString());
  } catch {
    return next(QuoterError.assetNotSupported(`Invalid asset address: ${req.body.asset}`));
  }

  let extraGas = Boolean(req.body.extraGas);

  const config = getAssetConfig(chainId, asset);
  if (config === undefined)
    return next(QuoterError.assetNotSupported(`Asset ${asset} for chain ${chainId} is not supported`));

  if (isNative(asset)) {
    extraGas = false;
  }

  let quote: QuoteFee;
  try {
    quote = await quoteService.quoteFeeBPSNative({
      chainId, amountIn, assetAddress: asset, baseFeeBPS: config.fee_bps, extraGas: extraGas
    });
  } catch (e) {
    return next(e);
  }

  const { feeBPS, gasPrice, extraGasFundAmount, relayTxCost, extraGasTxCost } = quote;
  const recipient = req.body.recipient ? getAddress(req.body.recipient.toString()) : undefined;
  const detail = {
    relayTxCost: { gas: relayTxCost, eth: relayTxCost * gasPrice },
    extraGasFundAmount: extraGasFundAmount ? { gas: extraGasFundAmount, eth: extraGasFundAmount * gasPrice } : undefined,
    extraGasTxCost: extraGasTxCost ? { gas: extraGasTxCost, eth: extraGasTxCost * gasPrice } : undefined,
  };

  const quoteResponse = new QuoteMarshall({
    baseFeeBPS: config.fee_bps,
    feeBPS,
    gasPrice,
    detail,
  });

  if (recipient) {
    let feeReceiverAddress: `0x${string}`;
    const finalFeeReceiverAddress = getAddress(getFeeReceiverAddress(chainId));
    if (extraGas) {
      const signer = privateKeyToAccount(getSignerPrivateKey(chainId) as `0x${string}`);
      if (isFeeReceiverSameAsSigner(chainId)) {
        feeReceiverAddress = finalFeeReceiverAddress;
      } else {
        feeReceiverAddress = signer.address;
      }
    } else {
      feeReceiverAddress = finalFeeReceiverAddress;
    }
    const withdrawalData = encodeWithdrawalData({
      feeRecipient: getAddress(feeReceiverAddress),
      recipient,
      relayFeeBPS: feeBPS
    });
    const expiration = Number(new Date()) + EXPIRATION_TIME;
    const relayerCommitment = { withdrawalData, expiration, asset, amount: amountIn, extraGas };
    const signedRelayerCommitment = await web3Provider.signRelayerCommitment(chainId, relayerCommitment);
    quoteResponse.addFeeCommitment({ expiration, asset, withdrawalData, signedRelayerCommitment, extraGas, amount: amountIn });
  }

  res
    .status(200)
    .json(res.locals.marshalResponse(quoteResponse));

}

import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Res,
} from "@nestjs/common";
import { z } from "zod";
import { WagerApplicationService } from "../../application/wager-application-service";

const Identifier = z.string().trim().min(1).max(200);
const SubmitWagerSchema = z
  .object({
    providerId: Identifier,
    externalTransactionId: Identifier,
    playerId: Identifier,
    walletId: z.string().uuid(),
    roundId: Identifier,
    gameId: Identifier,
    kind: z.enum(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]),
    money: z
      .object({
        amount: z
          .string()
          .max(100)
          .regex(/^\d+\.\d{2}$/),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict(),
    referenceExternalTransactionId: Identifier.optional(),
  })
  .strict();

const TransactionIdentitySchema = z.string().trim().min(1).max(200);

interface StatusResponse {
  status(statusCode: number): unknown;
}

@Controller("wagering/transactions")
export class WagerController {
  constructor(
    @Inject(WagerApplicationService)
    private readonly wagers: WagerApplicationService,
  ) {}

  @Post()
  async submit(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
  ) {
    const input = SubmitWagerSchema.parse(body);
    const result = await this.wagers.submit(input, idempotencyKey);
    response.status(result.httpStatus);
    return result.body;
  }

  @Get(":transactionId")
  findById(@Param("transactionId") transactionId: string) {
    return this.wagers.findById(z.string().uuid().parse(transactionId));
  }
}

@Controller("providers")
export class ProviderWagerController {
  constructor(
    @Inject(WagerApplicationService)
    private readonly wagers: WagerApplicationService,
  ) {}

  @Get(":providerId/wagering/transactions/:externalTransactionId")
  findByExternalIdentity(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return this.wagers.findByExternalIdentity(
      TransactionIdentitySchema.parse(providerId),
      TransactionIdentitySchema.parse(externalTransactionId),
    );
  }
}

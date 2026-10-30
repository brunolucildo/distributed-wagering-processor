import { Global, MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { CorrelationIdMiddleware } from "./correlation-context";

@Global()
@Module({
  providers: [CorrelationIdMiddleware],
  exports: [CorrelationIdMiddleware],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes("*");
  }
}

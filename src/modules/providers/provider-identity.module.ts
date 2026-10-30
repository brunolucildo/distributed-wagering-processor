import { Module } from "@nestjs/common";
import { ProviderIdentityPort } from "./provider-identity.port";
import { UnconfiguredProviderIdentityAdapter } from "./unconfigured-provider-identity.adapter";

@Module({
  providers: [
    {
      provide: ProviderIdentityPort,
      useClass: UnconfiguredProviderIdentityAdapter,
    },
  ],
  exports: [ProviderIdentityPort],
})
export class ProviderIdentityModule {}

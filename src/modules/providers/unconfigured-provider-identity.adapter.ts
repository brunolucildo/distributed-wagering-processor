import { Injectable } from "@nestjs/common";
import {
  AuthenticatedProvider,
  ProviderIdentityPort,
} from "./provider-identity.port";

@Injectable()
export class UnconfiguredProviderIdentityAdapter extends ProviderIdentityPort {
  async authenticate(): Promise<AuthenticatedProvider | undefined> {
    return undefined;
  }
}

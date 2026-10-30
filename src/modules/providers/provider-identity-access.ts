import { ForbiddenException } from "@nestjs/common";
import { ProviderIdentityPort } from "./provider-identity.port";

export async function assertProviderAccess(
  identityPort: ProviderIdentityPort,
  providerId: string,
  authorizationHeader: string | undefined,
): Promise<void> {
  const identity = await identityPort.authenticate(authorizationHeader);
  if (identity && identity.providerId !== providerId) {
    throw new ForbiddenException(
      "Provider identity does not match the request.",
    );
  }
}

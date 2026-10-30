export interface AuthenticatedProvider {
  providerId: string;
}

export abstract class ProviderIdentityPort {
  abstract authenticate(
    authorizationHeader: string | undefined,
  ): Promise<AuthenticatedProvider | undefined>;
}

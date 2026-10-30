import { describe, expect, test } from "bun:test";
import { assertProviderAccess } from "../../src/modules/providers/provider-identity-access";
import { ProviderIdentityPort } from "../../src/modules/providers/provider-identity.port";
import { UnconfiguredProviderIdentityAdapter } from "../../src/modules/providers/unconfigured-provider-identity.adapter";

describe("provider identity extension point", () => {
  test("leaves provider identity unauthenticated when no adapter is configured", async () => {
    const adapter = new UnconfiguredProviderIdentityAdapter();
    await expect(
      assertProviderAccess(adapter, "provider-a", undefined),
    ).resolves.toBeUndefined();
  });

  test("rejects a provider identity that does not match the request", async () => {
    class AuthenticatedIdentity extends ProviderIdentityPort {
      async authenticate() {
        return { providerId: "provider-a" };
      }
    }

    await expect(
      assertProviderAccess(
        new AuthenticatedIdentity(),
        "provider-b",
        "Bearer test-token",
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  test("allows an authenticated provider to access its own identity", async () => {
    class AuthenticatedIdentity extends ProviderIdentityPort {
      async authenticate() {
        return { providerId: "provider-a" };
      }
    }

    await expect(
      assertProviderAccess(
        new AuthenticatedIdentity(),
        "provider-a",
        "Bearer test-token",
      ),
    ).resolves.toBeUndefined();
  });
});

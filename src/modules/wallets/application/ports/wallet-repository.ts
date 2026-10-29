import { Wallet, WalletOpening } from "../../domain/entities/wallet";

export abstract class WalletRepository {
  abstract create(opening: WalletOpening): Promise<Wallet>;
  abstract findById(id: string): Promise<Wallet | null>;
}

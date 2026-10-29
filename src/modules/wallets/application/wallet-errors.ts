export class WalletAlreadyExistsError extends Error {
  constructor() {
    super("A wallet already exists for this player and currency.");
    this.name = "WalletAlreadyExistsError";
  }
}

export class WalletNotFoundError extends Error {
  constructor() {
    super("Wallet not found.");
    this.name = "WalletNotFoundError";
  }
}

export class InvalidWalletRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWalletRequestError";
  }
}

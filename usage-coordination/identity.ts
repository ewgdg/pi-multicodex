import { createHash } from "node:crypto";

export function normalizeManagedAccountIdentity(email: string): string {
	return email.trim().toLowerCase();
}

export function deriveManagedAccountDigest(email: string): string {
	return createHash("sha256")
		.update(normalizeManagedAccountIdentity(email))
		.digest("hex");
}

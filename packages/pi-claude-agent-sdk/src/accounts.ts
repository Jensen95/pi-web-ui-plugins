export interface AccountConfig {
	anthropic?: {
		authProvider?: string;
		baseUrl?: string;
		tokenEnv?: string;
		apiKeyEnv?: string;
	};
	codex?: {
		accessTokenEnv?: string;
		accountIdEnv?: string;
		authFile?: string;
		usageEndpoint?: string;
	};
}

export interface AccountsConfig {
	activeAccount?: string;
	accounts?: Record<string, AccountConfig>;
}

export interface ResolvedAccount {
	name: string;
	config: AccountConfig;
}

export function accountNames(config: AccountsConfig): string[] {
	return Object.keys(config.accounts ?? {}).sort();
}

export function resolveAccount(config: AccountsConfig, name?: string): ResolvedAccount {
	const accounts = config.accounts ?? {};
	if (name !== undefined && !name.trim()) throw new Error("account name must not be blank");
	if (Object.keys(accounts).length === 0) {
		if (name !== undefined && name !== "default") throw new Error(`unknown account "${name}"`);
		return { name: "default", config: {} };
	}

	const selected = name ?? config.activeAccount ?? accountNames(config)[0];
	if (!selected?.trim()) throw new Error("account name must not be blank");
	if (!Object.hasOwn(accounts, selected)) throw new Error(`unknown account "${selected}"`);
	const account = accounts[selected];
	if (!account) throw new Error(`unknown account "${selected}"`);
	return { name: selected, config: account };
}

export function selectAccount(config: AccountsConfig, name: string): AccountsConfig {
	resolveAccount(config, name);
	return { ...config, activeAccount: name };
}

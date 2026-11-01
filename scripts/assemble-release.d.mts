export declare const PLATFORM_FILES: Readonly<Record<'linux' | 'windows' | 'mac', { required: RegExp[]; optional: RegExp[] }>>
export declare function planRelease(listings: Record<string, string[]>): { take: { platform: string; name: string }[]; errors: string[] }

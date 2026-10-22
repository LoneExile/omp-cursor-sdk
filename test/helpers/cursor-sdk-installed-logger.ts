import { runInThisContext } from "node:vm";
import ts from "typescript";
import { type CursorSdkBuild, cursorSdkBuildEntry, readCursorSdkEntrySource } from "./cursor-sdk-build-source.js";

// Test-only execution of the INSTALLED SDK's own printer, so tests assert the bytes the SDK really prints
// rather than a hand-copied format. No replacement SDK code is shipped; a missing module or export fails the
// contract instead of guessing.
//
// The package ships three builds and the runtime picks one by condition: omp (Bun) loads `dist/bundled`
// (package.json exports "bun"), Node ESM `dist/esm`, CommonJS `dist/cjs`. The filter must hold for all three.

export interface InstalledSdkLoggerContext {
	withName(name: string): InstalledSdkLoggerContext;
}
interface InstalledSdkLoggerCall {
	(context: InstalledSdkLoggerContext, message: string, metadata?: Record<string, unknown>): void;
}
export interface InstalledSdkLogger {
	context(name?: string): InstalledSdkLoggerContext;
	info: InstalledSdkLoggerCall;
	warn: InstalledSdkLoggerCall;
}

function parseScript(build: CursorSdkBuild): ts.SourceFile {
	return ts.createSourceFile(cursorSdkBuildEntry(build), readCursorSdkEntrySource(build), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

/**
 * The SDK printer decides colors when it is created and captures its console, so the color environment is
 * pinned only while it is created (the SDK also disables color for NO_COLOR and TERM=dumb, which maintainer
 * shells set).
 */
function withColorEnvironment<T>(useColors: boolean, create: () => T): T {
	const env = process.env;
	const previous = { FORCE_COLOR: env.FORCE_COLOR, NO_COLOR: env.NO_COLOR, TERM: env.TERM };
	delete env.NO_COLOR;
	env.FORCE_COLOR = useColors ? "1" : "0";
	env.TERM = "xterm";
	try {
		return create();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete env[key];
			else env[key] = value;
		}
	}
}

// ---- esm and cjs: webpack-style module table in index.js ------------------------------------------------

interface SdkModule {
	exports: Record<string, unknown>;
}
type SdkModuleFactory = (module: SdkModule, exports: Record<string, unknown>, load: SdkModuleLoader) => void;
interface SdkModuleLoader {
	(name: string): Record<string, unknown>;
	r(target: object): void;
	d(target: object, getters: Record<string, () => unknown>): void;
	n(value: { __esModule?: boolean; default?: unknown } | undefined): () => unknown;
	o(target: object, key: string): boolean;
}

const LOGGER_MODULE = "../context/dist/logger.js";
const CORE_MODULE = "../context/dist/core.js";
const moduleTables = new Map<CursorSdkBuild, Record<string, SdkModuleFactory>>();

function readModuleTable(build: CursorSdkBuild): Record<string, SdkModuleFactory> {
	const cached = moduleTables.get(build);
	if (cached) return cached;
	const entry = cursorSdkBuildEntry(build);
	const ast = parseScript(build);
	let found: Record<string, SdkModuleFactory> | undefined;
	const visit = (node: ts.Node): void => {
		if (found) return;
		if (
			ts.isObjectLiteralExpression(node) &&
			node.properties.some((property) => property.name && ts.isStringLiteral(property.name) && property.name.text === LOGGER_MODULE)
		) {
			// Evaluating the table only defines the factory functions; none of them runs here.
			found = runInThisContext(`(${node.getText(ast)})`, { filename: entry }) as Record<string, SdkModuleFactory>;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(ast);
	if (!found) throw new Error(`Installed SDK ${build} module table changed: logger module not found`);
	moduleTables.set(build, found);
	return found;
}

function createModuleLoader(table: Record<string, SdkModuleFactory>): SdkModuleLoader {
	const cache: Record<string, Record<string, unknown>> = {};
	const load: SdkModuleLoader = Object.assign(
		(name: string): Record<string, unknown> => {
			if (!name.startsWith(".")) throw new Error(`Installed SDK logger now depends on external module ${name}`);
			const cached = cache[name];
			if (cached) return cached;
			const factory = table[name];
			if (!factory) throw new Error(`Installed SDK module missing: ${name}`);
			const module: SdkModule = { exports: {} };
			cache[name] = module.exports;
			factory(module, module.exports, load);
			return (cache[name] = module.exports);
		},
		{
			r: (target: object) => {
				Object.defineProperty(target, "__esModule", { value: true });
			},
			d: (target: object, getters: Record<string, () => unknown>) => {
				for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { enumerable: true, get });
			},
			n: (value: { __esModule?: boolean; default?: unknown } | undefined) => (value?.__esModule ? () => value.default : () => value),
			o: (target: object, key: string) => Object.hasOwn(target, key),
		},
	);
	return load;
}

function loadModuleTableLogger(build: "esm" | "cjs", useColors: boolean, loggerName: string): InstalledSdkLogger {
	const { core, logger } = withColorEnvironment(useColors, () => {
		const load = createModuleLoader(readModuleTable(build));
		return { core: load(CORE_MODULE), logger: load(LOGGER_MODULE) };
	});
	const contextFactories = Object.values(core).filter(
		(value): value is () => InstalledSdkLoggerContext => typeof value === "function" && value.length === 0,
	);
	const loggerFactories = Object.values(logger).filter(
		(value): value is (name: string) => { info: InstalledSdkLoggerCall; warn: InstalledSdkLoggerCall } => typeof value === "function",
	);
	if (contextFactories.length !== 1 || loggerFactories.length !== 1) throw new Error(`Installed SDK ${build} context/logger exports changed`);
	const createContext = contextFactories[0]!;
	const sdkLogger = loggerFactories[0]!(loggerName);
	return {
		context: (name) => (name ? createContext().withName(name) : createContext()),
		info: sdkLogger.info,
		warn: sdkLogger.warn,
	};
}

// ---- bundled: one flat bun bundle, no module table -----------------------------------------------------

interface BundledPrinterSource {
	file: string;
	/** Source of the printer factory and every top-level declaration it (transitively) uses. */
	declarations: string;
	factoryName: string;
}
interface PrinterRecord {
	level: "info" | "warn";
	message: string;
	timestamp: Date;
	context: unknown;
	metadata: Record<string, unknown> | undefined;
}
interface BundledPrinter {
	log(unused: unknown, record: PrinterRecord): void;
}
let bundledPrinterSource: BundledPrinterSource | undefined;

/**
 * Cuts the SDK's console printer out of the flat bundle: the one top-level function that pads the level to
 * five columns, plus every top-level function and variable declaration reachable from it by name. The printer
 * has no other dependencies, so the cut runs unmodified.
 */
function readBundledPrinterSource(): BundledPrinterSource {
	if (bundledPrinterSource) return bundledPrinterSource;
	const file = cursorSdkBuildEntry("bundled");
	const ast = parseScript("bundled");
	const declarations = new Map<string, ts.FunctionDeclaration | ts.VariableDeclaration>();
	for (const statement of ast.statements) {
		if (ts.isFunctionDeclaration(statement) && statement.name) declarations.set(statement.name.text, statement);
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, declaration);
			}
		}
	}
	const factories = [...declarations.values()].filter(
		(declaration): declaration is ts.FunctionDeclaration => ts.isFunctionDeclaration(declaration) && declaration.getText(ast).includes("padEnd(5)"),
	);
	if (factories.length !== 1) throw new Error(`Installed SDK bundled printer changed: ${factories.length} padEnd(5) functions`);
	const factory = factories[0]!;
	const factoryName = factory.name!.text;
	const reachable = [factoryName];
	for (let index = 0; index < reachable.length; index += 1) {
		const visit = (node: ts.Node): void => {
			if (ts.isIdentifier(node) && declarations.has(node.text) && !reachable.includes(node.text)) reachable.push(node.text);
			ts.forEachChild(node, visit);
		};
		visit(declarations.get(reachable[index]!)!);
	}
	bundledPrinterSource = {
		file,
		factoryName,
		declarations: reachable
			.map((name) => {
				const declaration = declarations.get(name)!;
				return ts.isFunctionDeclaration(declaration) ? declaration.getText(ast) : `var ${declaration.getText(ast)};`;
			})
			.join("\n"),
	};
	return bundledPrinterSource;
}

class BundledContext implements InstalledSdkLoggerContext {
	constructor(private readonly path: readonly string[] = []) {}

	withName(name: string): BundledContext {
		return new BundledContext([...this.path, name]);
	}

	// The printer asks its context for the path (`ctx=a/b`).
	getPath(): readonly string[] {
		return this.path;
	}
}

function loadBundledPrinter(useColors: boolean): InstalledSdkLogger {
	const source = readBundledPrinterSource();
	const printer = withColorEnvironment(useColors, () => {
		const create = runInThisContext(`(function (process, console) {\n${source.declarations}\nreturn ${source.factoryName}();\n})`, {
			filename: source.file,
		}) as (process: unknown, console: unknown) => BundledPrinter;
		// The printer looks its console methods up at call time, so a capture installed later still sees every frame.
		return create(process, console);
	});
	const print = (level: "info" | "warn"): InstalledSdkLoggerCall => (context, message, metadata) => {
		printer.log(null, { level, message, timestamp: new Date(), context, metadata });
	};
	return { context: (name) => (name ? new BundledContext().withName(name) : new BundledContext()), info: print("info"), warn: print("warn") };
}

/** Evaluates the installed build's printer fresh (colors on or off). */
export function loadInstalledSdkLogger(build: CursorSdkBuild, useColors: boolean): InstalledSdkLogger {
	return build === "bundled" ? loadBundledPrinter(useColors) : loadModuleTableLogger(build, useColors, "local-exec:cursor-rules");
}

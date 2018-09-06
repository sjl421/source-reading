/*
 MIT License http://www.opensource.org/licenses/mit-license.php
 Author Tobias Koppers @sokra
 */
"use strict";

const path = require("path");
const asyncLib = require("neo-async");
const {
	Tapable,
	AsyncSeriesWaterfallHook,
	SyncWaterfallHook,
	SyncBailHook,
	SyncHook,
	HookMap
} = require("tapable");
const NormalModule = require("./NormalModule");
const RawModule = require("./RawModule");
const RuleSet = require("./RuleSet");
const cachedMerge = require("./util/cachedMerge");

const EMPTY_RESOLVE_OPTIONS = {};

const MATCH_RESOURCE_REGEX = /^([^!]+)!=!/;

const loaderToIdent = data => {
	if (!data.options) {
		return data.loader;
	}
	if (typeof data.options === "string") {
		return data.loader + "?" + data.options;
	}
	if (typeof data.options !== "object") {
		throw new Error("loader options must be string or object");
	}
	if (data.ident) {
		return data.loader + "??" + data.ident;
	}
	return data.loader + "?" + JSON.stringify(data.options);
};

const identToLoaderRequest = resultString => {
	const idx = resultString.indexOf("?");
	if (idx >= 0) {
		const loader = resultString.substr(0, idx);
		const options = resultString.substr(idx + 1);
		return {
			loader,
			options
		};
	} else {
		return {
			loader: resultString,
			options: undefined
		};
	}
};

const dependencyCache = new WeakMap();

class NormalModuleFactory extends Tapable {
	constructor(context, resolverFactory, options) {
		super();
		this.hooks = {
			resolver: new SyncWaterfallHook(["resolver"]),
			factory: new SyncWaterfallHook(["factory"]),
			beforeResolve: new AsyncSeriesWaterfallHook(["data"]),
			afterResolve: new AsyncSeriesWaterfallHook(["data"]),
			createModule: new SyncBailHook(["data"]),
			module: new SyncWaterfallHook(["module", "data"]),
			createParser: new HookMap(() => new SyncBailHook(["parserOptions"])),
			parser: new HookMap(() => new SyncHook(["parser", "parserOptions"])),
			createGenerator: new HookMap(
				() => new SyncBailHook(["generatorOptions"])
			),
			generator: new HookMap(
				() => new SyncHook(["generator", "generatorOptions"])
			)
		};
		this._pluginCompat.tap("NormalModuleFactory", options => {
			switch (options.name) {
				case "before-resolve":
				case "after-resolve":
					options.async = true;
					break;
				case "parser":
					this.hooks.parser
						.for("javascript/auto")
						.tap(options.fn.name || "unnamed compat plugin", options.fn);
					return true;
			}
			let match;
			match = /^parser (.+)$/.exec(options.name);
			if (match) {
				this.hooks.parser
					.for(match[1])
					.tap(
						options.fn.name || "unnamed compat plugin",
						options.fn.bind(this)
					);
				return true;
			}
			match = /^create-parser (.+)$/.exec(options.name);
			if (match) {
				this.hooks.createParser
					.for(match[1])
					.tap(
						options.fn.name || "unnamed compat plugin",
						options.fn.bind(this)
					);
				return true;
			}
		});
		this.resolverFactory = resolverFactory;
		this.ruleSet = new RuleSet(options.defaultRules.concat(options.rules));
		this.cachePredicate =
			typeof options.unsafeCache === "function"
				? options.unsafeCache
				: Boolean.bind(null, options.unsafeCache);
		this.context = context || "";
		this.parserCache = Object.create(null);
		this.generatorCache = Object.create(null);

		// [tip] 构造函数中在factory钩子上注册方法
		this.hooks.factory.tap("NormalModuleFactory", () => (result, callback) => {
			let resolver = this.hooks.resolver.call(null);

			// Ignored
			if (!resolver) return callback();

			// [tip] 这里就可以从data中获取下面resolver钩子中异步返回的对象
			resolver(result, (err, data) => {
				if (err) return callback(err);

				// Ignored
				if (!data) return callback();

				// direct module
				if (typeof data.source === "function") return callback(null, data);

				// [tip] hook afterResolve
				this.hooks.afterResolve.callAsync(data, (err, result) => {
					if (err) return callback(err);

					// Ignored
					if (!result) return callback();

					// [tip] hook createModule
					let createdModule = this.hooks.createModule.call(result);
					if (!createdModule) {
						if (!result.request) {
							return callback(new Error("Empty dependency (no request)"));
						}

						// [tip] 创建模块对象
						createdModule = new NormalModule(result);
					}

					// [tip] hook module
					createdModule = this.hooks.module.call(createdModule, result);

					return callback(null, createdModule);
				});
			});
		});

		// [tip] 构造函数中在resolver钩子上注册方法
		this.hooks.resolver.tap("NormalModuleFactory", () => (data, callback) => {
			const contextInfo = data.contextInfo;
			const context = data.context;
			const request = data.request;

			// [tip] 对loader与normal模块，可以设置不同的resolver
			const loaderResolver = this.getResolver("loader");
			const normalResolver = this.getResolver("normal", data.resolveOptions);

			let matchResource = undefined;
			let requestWithoutMatchResource = request;
			const matchResourceMatch = MATCH_RESOURCE_REGEX.exec(request);
			if (matchResourceMatch) {
				matchResource = matchResourceMatch[1];
				if (/^\.\.?\//.test(matchResource)) {
					matchResource = path.join(context, matchResource);
				}
				requestWithoutMatchResource = request.substr(
					matchResourceMatch[0].length
				);
			}

			const noPreAutoLoaders = requestWithoutMatchResource.startsWith("-!");
			const noAutoLoaders =
				noPreAutoLoaders || requestWithoutMatchResource.startsWith("!");
			const noPrePostAutoLoaders = requestWithoutMatchResource.startsWith("!!");
			// [tip] 将request解析为inline-loader和实际模块(先解析inline-loader)
			let elements = requestWithoutMatchResource
				.replace(/^-?!+/, "")
				.replace(/!!+/g, "!")
				.split("!");
			// [tip] 解析后elements中最后一个是实际模块，其余为该模块所需的各种loader
			let resource = elements.pop();
			elements = elements.map(identToLoaderRequest);

			// [tip] 异步并行解析（主要是模块路径等信息）
			asyncLib.parallel(
				[
					callback =>
						this.resolveRequestArray(
							contextInfo,
							context,
							elements,
							loaderResolver,
							callback
						),
					callback => {
						if (resource === "" || resource[0] === "?") {
							return callback(null, {
								resource
							});
						}

						normalResolver.resolve(
							contextInfo,
							context,
							resource,
							{},
							(err, resource, resourceResolveData) => {
								if (err) return callback(err);
								callback(null, {
									resourceResolveData,
									resource
								});
							}
						);
					}
				],
				// [tip] results结构
				/**
				[ [ { loader:
								'/Users/zhouhongxuan/programming/gitrepo/webpack-fis/basic-demo/home/node_modules/html-webpack-plugin/lib/loader.js',
				 			options: undefined } ],
		 			{ resourceResolveData:
							{ context: [Object],
								path:
					 			'/Users/zhouhongxuan/programming/gitrepo/webpack-fis/basic-demo/home/public/index.html',
								request: undefined,
								query: '',
								module: false,
								file: false,
								descriptionFilePath:
					 			'/Users/zhouhongxuan/programming/gitrepo/webpack-fis/basic-demo/home/package.json',
								descriptionFileData: [Object],
								descriptionFileRoot:
					 			'/Users/zhouhongxuan/programming/gitrepo/webpack-fis/basic-demo/home',
								relativePath: './public/index.html',
								__innerRequest_request: undefined,
								__innerRequest_relativePath: './public/index.html',
								__innerRequest: './public/index.html' },
			 			resource:
							'/Users/zhouhongxuan/programming/gitrepo/webpack-fis/basic-demo/home/public/index.html' } ]
				*/
				(err, results) => {
					if (err) return callback(err);
					let loaders = results[0];
					const resourceResolveData = results[1].resourceResolveData;
					resource = results[1].resource;

					// translate option idents
					try {
						for (const item of loaders) {
							if (typeof item.options === "string" && item.options[0] === "?") {
								const ident = item.options.substr(1);
								item.options = this.ruleSet.findOptionsByIdent(ident);
								item.ident = ident;
							}
						}
					} catch (e) {
						return callback(e);
					}

					// [tip] RawModule
					if (resource === false) {
						// ignored
						return callback(
							null,
							new RawModule(
								"/* (ignored) */",
								`ignored ${context} ${request}`,
								`${request} (ignored)`
							)
						);
					}

					// [tip] userRequest会包含loader，这里将之前获得的loader进行了格式化，为绝对路径
					// [tip] 例如 /Users/demo/node_modules/css-loader/index.js!/Users/demo/node_modules/less-loader/dist/cjs.js!/Users/demo/src/css/index.less
					const userRequest =
						(matchResource !== undefined ? `${matchResource}!=!` : "") +
						loaders
							.map(loaderToIdent)
							.concat([resource])
							.join("!");

					// [tip] 模块资源的绝对路径
					// [tip] 例如 /Users/demo/src/css/index.less
					// [tip] 也包括loader的一些辅助模块，例如 /Users/demo/node_modules/style-loader/lib/addStyles.js
					let resourcePath =
						matchResource !== undefined ? matchResource : resource;
					let resourceQuery = "";
					const queryIndex = resourcePath.indexOf("?");
					if (queryIndex >= 0) {
						resourceQuery = resourcePath.substr(queryIndex);
						resourcePath = resourcePath.substr(0, queryIndex);
					}

					// [tip] RuleSet类用来处理webpack.config中的各类loader条件，即处理module.rules（后解析config loader）
					const result = this.ruleSet.exec({
						resource: resourcePath,
						realResource:
							matchResource !== undefined
								? resource.replace(/\?.*/, "")
								: resourcePath,
						resourceQuery,
						issuer: contextInfo.issuer,
						compiler: contextInfo.compiler
					});
					const settings = {};
					const useLoadersPost = [];
					const useLoaders = [];
					const useLoadersPre = [];
					// [tip] Rule.enforce，loader分类
					for (const r of result) {
						if (r.type === "use") {
							if (r.enforce === "post" && !noPrePostAutoLoaders) {
								useLoadersPost.push(r.value);
							} else if (
								r.enforce === "pre" &&
								!noPreAutoLoaders &&
								!noPrePostAutoLoaders
							) {
								useLoadersPre.push(r.value);
							} else if (
								!r.enforce &&
								!noAutoLoaders &&
								!noPrePostAutoLoaders
							) {
								useLoaders.push(r.value);
							}
						} else if (
							typeof r.value === "object" &&
							r.value !== null &&
							typeof settings[r.type] === "object" &&
							settings[r.type] !== null
						) {
							settings[r.type] = cachedMerge(settings[r.type], r.value);
						} else {
							settings[r.type] = r.value;
						}
					}
					// [tip] 异步并行解析各类loader（主要是模块路径等信息）：post-loader/normal-loader/pre-loader
					asyncLib.parallel(
						[
							this.resolveRequestArray.bind(
								this,
								contextInfo,
								this.context,
								useLoadersPost,
								loaderResolver
							),
							this.resolveRequestArray.bind(
								this,
								contextInfo,
								this.context,
								useLoaders,
								loaderResolver
							),
							this.resolveRequestArray.bind(
								this,
								contextInfo,
								this.context,
								useLoadersPre,
								loaderResolver
							)
						],
						(err, results) => {
							if (err) return callback(err);
							// [tip] 按post, inline, normal, pre顺序合并loader数组
							loaders = results[0].concat(loaders, results[1], results[2]);
							process.nextTick(() => {
								const type = settings.type;
								const resolveOptions = settings.resolve;
								// [tip] 返回模块路径解析完毕后各个ModuleFactory对应的值，此时所需的loader的路径也已解析完毕
								callback(null, {
									context: context,
									request: loaders
										.map(loaderToIdent)
										.concat([resource])
										.join("!"),
									// [doubt] data.dependencies 是在何时处理出来的？
									dependencies: data.dependencies,
									userRequest,
									rawRequest: request,
									loaders,
									resource,
									matchResource,
									resourceResolveData,
									settings,
									type,
									parser: this.getParser(type, settings.parser),
									generator: this.getGenerator(type, settings.generator),
									resolveOptions
								});
							});
						}
					);
				}
			);
		});
	}

	create(data, callback) {
		const dependencies = data.dependencies;
		// [tip] 模块缓存，减少每次处理量
		const cacheEntry = dependencyCache.get(dependencies[0]);
		if (cacheEntry) return callback(null, cacheEntry);
		const context = data.context || this.context;
		const resolveOptions = data.resolveOptions || EMPTY_RESOLVE_OPTIONS;
		const request = dependencies[0].request;
		const contextInfo = data.contextInfo || {};
		// [doubt] 哪里会用到beforeResolve钩子
		// [tip] hook beforeResolve
		this.hooks.beforeResolve.callAsync(
			{
				contextInfo,
				resolveOptions,
				context,
				request,
				dependencies
			},
			(err, result) => {
				if (err) return callback(err);

				// Ignored
				if (!result) return callback();

				// [tip] hook beforeResolve
				const factory = this.hooks.factory.call(null);

				// Ignored
				if (!factory) return callback();

				factory(result, (err, module) => {
					if (err) return callback(err);

					// [tip] 只有允许使用cache(cachePredicate返回true)时可以进行缓存
					// [doubt] dependencies的含义以及缓存的含义
					if (module && this.cachePredicate(module)) {
						for (const d of dependencies) {
							dependencyCache.set(d, module);
						}
					}

					callback(null, module);
				});
			}
		);
	}

	resolveRequestArray(contextInfo, context, array, resolver, callback) {
		if (array.length === 0) return callback(null, []);
		asyncLib.map(
			array,
			(item, callback) => {
				resolver.resolve(
					contextInfo,
					context,
					item.loader,
					{},
					(err, result) => {
						if (
							err &&
							/^[^/]*$/.test(item.loader) &&
							!/-loader$/.test(item.loader)
						) {
							return resolver.resolve(
								contextInfo,
								context,
								item.loader + "-loader",
								{},
								err2 => {
									if (!err2) {
										err.message =
											err.message +
											"\n" +
											"BREAKING CHANGE: It's no longer allowed to omit the '-loader' suffix when using loaders.\n" +
											`                 You need to specify '${
												item.loader
											}-loader' instead of '${item.loader}',\n` +
											"                 see https://webpack.js.org/migrate/3/#automatic-loader-module-name-extension-removed";
									}
									callback(err);
								}
							);
						}
						if (err) return callback(err);

						const optionsOnly = item.options
							? {
									options: item.options
							  }
							: undefined;
						return callback(
							null,
							Object.assign({}, item, identToLoaderRequest(result), optionsOnly)
						);
					}
				);
			},
			callback
		);
	}

	getParser(type, parserOptions) {
		let ident = type;
		if (parserOptions) {
			if (parserOptions.ident) {
				ident = `${type}|${parserOptions.ident}`;
			} else {
				ident = JSON.stringify([type, parserOptions]);
			}
		}
		if (ident in this.parserCache) {
			return this.parserCache[ident];
		}
		return (this.parserCache[ident] = this.createParser(type, parserOptions));
	}

	createParser(type, parserOptions = {}) {
		const parser = this.hooks.createParser.for(type).call(parserOptions);
		if (!parser) {
			throw new Error(`No parser registered for ${type}`);
		}
		this.hooks.parser.for(type).call(parser, parserOptions);
		return parser;
	}

	getGenerator(type, generatorOptions) {
		let ident = type;
		if (generatorOptions) {
			if (generatorOptions.ident) {
				ident = `${type}|${generatorOptions.ident}`;
			} else {
				ident = JSON.stringify([type, generatorOptions]);
			}
		}
		if (ident in this.generatorCache) {
			return this.generatorCache[ident];
		}
		return (this.generatorCache[ident] = this.createGenerator(
			type,
			generatorOptions
		));
	}

	createGenerator(type, generatorOptions = {}) {
		const generator = this.hooks.createGenerator
			.for(type)
			.call(generatorOptions);
		if (!generator) {
			throw new Error(`No generator registered for ${type}`);
		}
		this.hooks.generator.for(type).call(generator, generatorOptions);
		return generator;
	}

	getResolver(type, resolveOptions) {
		return this.resolverFactory.get(
			type,
			resolveOptions || EMPTY_RESOLVE_OPTIONS
		);
	}
}

module.exports = NormalModuleFactory;

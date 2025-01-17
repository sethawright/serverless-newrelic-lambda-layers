"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const _ = require("lodash");
const node_fetch_1 = require("node-fetch");
const semver = require("semver");
const api_1 = require("./api");
const integration_1 = require("./integration");
const utils_1 = require("./utils");
const DEFAULT_FILTER_PATTERNS = [
    "REPORT",
    "NR_LAMBDA_MONITORING",
    "Task timed out",
    "RequestId",
];
// The plugin uses only these log levels:
const logShim = {
    error: console.error,
    warning: console.log,
    notice: console.log, // tslint:disable-line
};
const wrappableRuntimeList = [
    "nodejs14.x",
    "nodejs16.x",
    "nodejs18.x",
    "python3.7",
    "python3.8",
    "python3.9",
    "python3.10",
    "python3.11",
    "java11",
    "java8.al2",
];
class NewRelicLambdaLayerPlugin {
    constructor(serverless, options, logParam) {
        this.serverless = serverless;
        this.options = options;
        // The run-from-lib method used by the test can't supply a log object, so this is a fallback:
        this.log = logParam && logParam.log ? logParam.log : logShim;
        this.awsProvider = this.serverless.getProvider("aws");
        this.licenseKey = null;
        this.managedSecretConfigured = false;
        this.mgdPolicyArns = [];
        this.extFellBackToCW = false;
        this.hooks = this.shouldSkipPlugin()
            ? {}
            : {
                "after:deploy:deploy": this.addLogSubscriptions.bind(this),
                "after:deploy:function:packageFunction": this.cleanup.bind(this),
                "after:package:createDeploymentArtifacts": this.cleanup.bind(this),
                "before:deploy:deploy": this.checkIntegration.bind(this),
                "before:deploy:function:packageFunction": this.run.bind(this),
                "before:package:createDeploymentArtifacts": this.run.bind(this),
                "before:remove:remove": this.removeLogSubscriptions.bind(this),
            };
    }
    get region() {
        return _.get(this.serverless.service, "provider.region", "us-east-1");
    }
    get config() {
        return _.get(this.serverless, "service.custom.newRelic", {
            nrRegion: "us",
        });
    }
    get managedPolicyArns() {
        const managedPolicyArns = _.get(this.serverless, "service.provider.managedPolicyArns", false);
        return managedPolicyArns || [];
    }
    get resources() {
        return _.get(this.serverless, "service.provider.compiledCloudFormationTemplate.Resources", {});
    }
    get stage() {
        return ((this.options && this.options.stage) ||
            (this.serverless.service.provider &&
                this.serverless.service.provider.stage));
    }
    get prependLayer() {
        return typeof this.config.prepend === "boolean" && this.config.prepend;
    }
    get autoSubscriptionDisabled() {
        return (typeof this.config.disableAutoSubscription === "boolean" &&
            this.config.disableAutoSubscription &&
            this.extFellBackToCW === false // only disable if ext config worked
        );
    }
    get licenseKeySecretDisabled() {
        return (typeof this.config.disableLicenseKeySecret === "boolean" &&
            this.config.disableLicenseKeySecret);
    }
    get javaNewRelicHandler() {
        if (this.config.javaNewRelicHandler &&
            this.config.javaNewRelicHandler === "handleStreamsRequest") {
            return "handleStreamsRequest" /* JavaHandler.handleStreamsRequest */;
        }
        return "handleRequest" /* JavaHandler.handleRequest */;
    }
    get functions() {
        return Object.assign.apply(null, this.serverless.service
            .getAllFunctions()
            .map((func) => ({ [func]: this.serverless.service.getFunction(func) })));
    }
    get extFallbackMessage() {
        return `
    
********************************************************************************

The variables in the custom block of your serverless.yml show that you've chosen 
to deliver telemetry via our Lambda Extension. The value of your personal 
New Relic API Key, however, was not found in your New Relic account. 
Are you sure you used the correct API key? If not, you can retrieve it from our 
Onboarding nerdlet for AWS Lambda: https://one.nr/0DvwBpoxbjp

For now, your function will still deliver telemetry to New Relic using a 
CloudWatch Log Subscription, but we recommend using the lambda extension.
Please see this link for more information: 
https://blog.newrelic.com/product-news/aws-lambda-extensions-integrations/

********************************************************************************

    `;
    }
    checkIntegration() {
        return new integration_1.default(this).check();
    }
    checkForSecretPolicy() {
        return __awaiter(this, void 0, void 0, function* () {
            return new integration_1.default(this).checkForManagedSecretPolicy();
        });
    }
    regionPolicyValid(current) {
        return __awaiter(this, void 0, void 0, function* () {
            return (current.currentRegionPolicy &&
                current.currentRegionPolicy[0] &&
                current.currentRegionPolicy[0].Arn);
        });
    }
    configureLicenseForExtension() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.licenseKey) {
                this.licenseKey = yield this.retrieveLicenseKey();
                if (!this.licenseKey) {
                    this.config.enableExtension = false;
                    this.extFellBackToCW = true;
                    this.log.warning("Unable to find NR License key for extension validation; falling back to CloudWatch for transport.");
                    return false;
                }
            }
            if (!this.licenseKeySecretDisabled) {
                // If the managed secret has already been created,
                // there should be policies for it.
                const secretAccess = yield this.checkForSecretPolicy();
                let managedSecret;
                if (secretAccess && secretAccess.secretExists) {
                    this.managedSecretConfigured = true;
                }
                else {
                    // Secret doesn't exist, so create it
                    managedSecret = yield new integration_1.default(this).createManagedSecret();
                    if (managedSecret && managedSecret.policyArn) {
                        this.managedSecretConfigured = true;
                    }
                }
                if (secretAccess &&
                    secretAccess.currentRegionPolicy &&
                    secretAccess.currentRegionPolicy.length &&
                    secretAccess.currentRegionPolicy.length > 0) {
                    const policyArn = secretAccess.currentRegionPolicy[0].Arn;
                    this.mgdPolicyArns = [...this.managedPolicyArns, policyArn];
                }
                else if (this.managedSecretConfigured) {
                    this.mgdPolicyArns = [
                        ...this.managedPolicyArns,
                        managedSecret.policyArn,
                    ];
                }
            }
            return true;
        });
    }
    applyPolicies(role) {
        const existingPolicyArns = role.ManagedPolicyArns || [];
        const nrManagedPolicyArns = this.mgdPolicyArns || [];
        role.ManagedPolicyArns = [...existingPolicyArns, ...nrManagedPolicyArns];
    }
    run() {
        return __awaiter(this, void 0, void 0, function* () {
            const version = this.serverless.getVersion();
            const nodeVersion = process.version;
            if (semver.lt(version, "1.34.0")) {
                this.log.error(`Serverless ${version} does not support layers. Please upgrade to >=1.34.0.`);
                return;
            }
            else if (semver.lt(version, "3.0.0")) {
                this.log.warning(`
The Serverless logging interface changed with the release of 3.x. This plugin is compatible with Serverless 3, 
but may not be fully compatible with Serverless ${version}. If you have trouble deploying, we recommend that you
either upgrade Serverless to >=3.0.0, or use version 2.4.1 of this plugin.
      `);
            }
            if (semver.lt(nodeVersion, "16.0.0")) {
                this.log.warning(`
If your version of NPM is earlier than v7, either update to a recent version of NPM, 
or make sure that you already have Serverless 3.x installed in your project.
      `);
            }
            function isEnhancedPlugins(pluginDef) {
                return !_.isArray(pluginDef) && pluginDef.modules;
            }
            let plugins = _.get(this.serverless, "service.plugins", []);
            if (isEnhancedPlugins(plugins)) {
                plugins = plugins.modules;
            }
            this.log.notice(`Plugins: ${JSON.stringify(plugins)}`);
            if (plugins.indexOf("serverless-webpack") >
                plugins.indexOf("serverless-newrelic-lambda-layers")) {
                this.log.error("serverless-newrelic-lambda-layers plugin must come after serverless-webpack in serverless.yml; skipping.");
                return;
            }
            if (plugins.indexOf("serverless-plugin-typescript") >
                plugins.indexOf("serverless-newrelic-lambda-layers")) {
                this.log.error("serverless-newrelic-lambda-layers plugin must come after serverless-plugin-typescript in serverless.yml; skipping.");
                return;
            }
            if (!this.config.apiKey) {
                this.log.error(`Please use a valid New Relic API key as your apiKey value; skipping.`);
                return;
            }
            const { exclude = [], include = [] } = this.config;
            if (!_.isEmpty(exclude) && !_.isEmpty(include)) {
                this.log.error("exclude and include options are mutually exclusive; skipping.");
                return;
            }
            const extensionDisabled = !_.isUndefined(this.config.enableExtension) &&
                (this.config.enableExtension === false ||
                    this.config.enableExtension === "false");
            if (!extensionDisabled) {
                // If using the extension, try to store the NR license key in a managed secret
                // for the extension to authenticate. If not, fall back to function environment variable
                const extConfig = yield this.configureLicenseForExtension();
                if (extConfig && (this.licenseKey || this.managedSecretConfigured)) {
                    // extension will be able to authenticate, so disable subscription
                    this.config.disableAutoSubscription = true;
                }
            }
            if (this.config.proxy) {
                this.log.notice(`HTTP proxy set to ${this.config.proxy}`);
            }
            if (!this.licenseKeySecretDisabled) {
                // before adding layer, attach secret access policy
                // to each function's execution role:
                const resources = this.resources;
                Object.keys(resources)
                    .filter((resourceName) => resources[resourceName].Type === `AWS::IAM::Role`)
                    .forEach((roleResource) => this.applyPolicies(resources[roleResource].Properties));
            }
            const funcs = this.functions;
            const promises = [];
            const functionsArray = _.values(funcs);
            const hasProviderLayers = _.get(this.serverless.service, "provider.layers", false);
            let shouldUseProviderLayers = false;
            if (functionsArray.length) {
                const functionsRuntimeList = functionsArray.map((f) => f.runtime);
                const functionsArchitectureList = functionsArray.map((f) => f.architecture);
                const isNotExcluding = !exclude || _.isEmpty(exclude);
                const isNotIncludingOrIncludingAll = !include ||
                    _.isEmpty(include) ||
                    (include &&
                        _.isArray(include) &&
                        include.length === functionsArray.length);
                const allFunctionsHaveTheSameRuntime = _.uniq(functionsRuntimeList).length === 1;
                const allFunctionsHaveTheSameArchitecture = _.uniq(functionsArchitectureList).length === 1;
                const runtime = functionsRuntimeList[0] ||
                    _.get(this.serverless.service, "provider.runtime");
                const architecture = functionsArchitectureList[0] ||
                    _.get(this.serverless.service, "provider.architecture");
                const layerArn = this.config.layerArn
                    ? this.config.layerArn
                    : yield this.getLayerArn(runtime, architecture);
                const runtimeIsWrappable = typeof runtime === "string" &&
                    wrappableRuntimeList.indexOf(runtime) !== -1;
                shouldUseProviderLayers =
                    isNotExcluding &&
                        isNotIncludingOrIncludingAll &&
                        allFunctionsHaveTheSameRuntime &&
                        allFunctionsHaveTheSameArchitecture &&
                        this.region && // Region is specified
                        this.config.accountId && // account id is specified
                        runtimeIsWrappable &&
                        layerArn; // has a layerArn;
                if (shouldUseProviderLayers) {
                    if (hasProviderLayers) {
                        this.serverless.service.provider.layers.push(layerArn);
                    }
                    else {
                        this.serverless.service.provider.layers = [layerArn];
                    }
                }
            }
            for (const funcName of Object.keys(funcs)) {
                const funcDef = funcs[funcName];
                promises.push(this.addLayer(funcName, funcDef, shouldUseProviderLayers));
            }
            yield Promise.all(promises);
        });
    }
    cleanup() {
        // any cleanup can happen here. Previously used for Node 8.
    }
    addLogSubscriptions() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.autoSubscriptionDisabled) {
                this.log.notice("Skipping adding log subscription. Explicitly disabled");
                return;
            }
            const funcs = this.functions;
            let { cloudWatchFilter = [...DEFAULT_FILTER_PATTERNS] } = this.config;
            let cloudWatchFilterString = "";
            if (typeof cloudWatchFilter === "object" &&
                cloudWatchFilter.indexOf("*") === -1) {
                cloudWatchFilter = cloudWatchFilter.map((el) => `?\"${el}\"`);
                cloudWatchFilterString = cloudWatchFilter.join(" ");
            }
            else if (cloudWatchFilter.indexOf("*") === -1) {
                cloudWatchFilterString = String(cloudWatchFilter);
            }
            this.log.notice(`log filter: ${cloudWatchFilterString}`);
            const promises = [];
            for (const funcName of Object.keys(funcs)) {
                if (this.shouldSkipFunction(funcName)) {
                    return;
                }
                this.log.notice(`Configuring New Relic log subscription for ${funcName}`);
                const funcDef = funcs[funcName];
                promises.push(this.ensureLogSubscription(funcDef.name, cloudWatchFilterString));
            }
            yield Promise.all(promises);
            if (this.extFellBackToCW) {
                this.log.notice(this.extFallbackMessage);
            }
        });
    }
    removeLogSubscriptions() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.autoSubscriptionDisabled) {
                this.log.notice("Skipping removing log subscription. Explicitly disabled");
                return;
            }
            const funcs = this.functions;
            const promises = [];
            for (const funcName of Object.keys(funcs)) {
                const { name } = funcs[funcName];
                this.log.notice(`Removing New Relic log subscription for ${funcName}`);
                promises.push(this.removeSubscriptionFilter(name));
            }
            yield Promise.all(promises);
        });
    }
    addLayer(funcName, funcDef, shouldUseProviderLayers = false) {
        return __awaiter(this, void 0, void 0, function* () {
            this.log.notice(`Adding NewRelic layer to ${funcName}`);
            if (!this.region) {
                this.log.warning("No AWS region specified for NewRelic layer; skipping.");
                return;
            }
            const { name, environment = {}, handler, runtime = _.get(this.serverless.service, "provider.runtime"), architecture = _.get(this.serverless.service, "provider.architecture", null), layers, package: pkg = {}, } = funcDef;
            if (!this.config.accountId && !environment.NEW_RELIC_ACCOUNT_ID) {
                this.log.warning(`No New Relic Account ID specified for "${funcName}"; skipping.`);
                return;
            }
            const wrappableRuntime = wrappableRuntimeList.indexOf(runtime) === -1;
            if (typeof runtime !== "string" ||
                (wrappableRuntime && !this.config.enableExtension)) {
                this.log.warning(`Unsupported runtime "${runtime}" for NewRelic layer; skipping.`);
                return;
            }
            if (this.shouldSkipFunction(funcName)) {
                return;
            }
            const layerArn = this.config.layerArn
                ? this.config.layerArn
                : yield this.getLayerArn(runtime, architecture);
            if (!layerArn) {
                return;
            }
            if (shouldUseProviderLayers && !layers) {
                this.log.warning(`Function "${funcName}" already will be handled with provider.layers; skipping.`);
            }
            else {
                const funcLayers = layers || [];
                const newRelicLayers = funcLayers.filter((layer) => typeof layer === "string" && layer.match(layerArn));
                // Note: This is if the user specifies a layer in their serverless.yml
                if (newRelicLayers.length) {
                    this.log.warning(`Function "${funcName}" already specifies an NewRelic layer; skipping.`);
                }
                else {
                    if (this.prependLayer) {
                        funcLayers.unshift(layerArn);
                    }
                    else {
                        funcLayers.push(layerArn);
                    }
                    funcDef.layers = funcLayers;
                }
            }
            environment.NEW_RELIC_LAMBDA_HANDLER = handler;
            if (this.config.logEnabled === true || this.config.logEnabled === "true") {
                this.logLevel(environment, runtime);
            }
            environment.NEW_RELIC_NO_CONFIG_FILE = environment.NEW_RELIC_NO_CONFIG_FILE
                ? environment.NEW_RELIC_NO_CONFIG_FILE
                : "true";
            environment.NEW_RELIC_APP_NAME = environment.NEW_RELIC_APP_NAME
                ? environment.NEW_RELIC_APP_NAME
                : name || funcName;
            environment.NEW_RELIC_ACCOUNT_ID = environment.NEW_RELIC_ACCOUNT_ID
                ? environment.NEW_RELIC_ACCOUNT_ID
                : this.config.accountId;
            if (this.config.enableDistributedTracing) {
                environment.NEW_RELIC_DISTRIBUTED_TRACING_ENABLED = "true";
            }
            environment.NEW_RELIC_TRUSTED_ACCOUNT_KEY =
                environment.NEW_RELIC_TRUSTED_ACCOUNT_KEY
                    ? environment.NEW_RELIC_TRUSTED_ACCOUNT_KEY
                    : this.config.trustedAccountKey
                        ? this.config.trustedAccountKey
                        : environment.NEW_RELIC_ACCOUNT_ID;
            if (runtime.match("python")) {
                environment.NEW_RELIC_SERVERLESS_MODE_ENABLED = "true";
            }
            const extensionDisabled = !_.isUndefined(this.config.enableExtension) &&
                (this.config.enableExtension === "false" ||
                    this.config.enableExtension === false);
            if (extensionDisabled) {
                environment.NEW_RELIC_LAMBDA_EXTENSION_ENABLED = "false";
            }
            else {
                if (!this.managedSecretConfigured && this.licenseKey) {
                    environment.NEW_RELIC_LICENSE_KEY = this.licenseKey;
                }
                if (this.config.enableFunctionLogs &&
                    this.config.enableFunctionLogs !== "false") {
                    environment.NEW_RELIC_EXTENSION_SEND_FUNCTION_LOGS = "true";
                    this.config.disableAutoSubscription = true;
                }
                if (!_.isUndefined(this.config.enableExtensionLogs) &&
                    (this.config.enableExtensionLogs === "false" ||
                        this.config.enableExtensionLogs === false)) {
                    environment.NEW_RELIC_EXTENSION_LOGS_ENABLED = "false";
                }
            }
            funcDef.environment = environment;
            funcDef.handler = this.getHandlerWrapper(runtime, handler);
            funcDef.package = this.updatePackageExcludes(runtime, pkg);
        });
    }
    shouldSkipPlugin() {
        if (!this.config.stages ||
            (this.config.stages && this.config.stages.includes(this.stage))) {
            return false;
        }
        this.log.warning(`Skipping plugin serverless-newrelic-lambda-layers for stage ${this.stage}`);
        return true;
    }
    shouldSkipFunction(funcName) {
        const { include = [], exclude = [] } = this.config;
        if (!_.isEmpty(include) &&
            _.isArray(include) &&
            include.indexOf(funcName) === -1) {
            this.log.warning(`Excluded function ${funcName}; is not part of include; skipping`);
            return true;
        }
        if (_.isArray(exclude) && exclude.indexOf(funcName) !== -1) {
            this.log.warning(`Excluded function ${funcName}; skipping`);
            return true;
        }
        return false;
    }
    logLevel(environment, runtime) {
        const isPython = String(runtime).toLocaleLowerCase().substring(0, 6) === "python";
        environment.NEW_RELIC_LOG_ENABLED = environment.NEW_RELIC_LOG_ENABLED
            ? environment.NEW_RELIC_LOG_ENABLED
            : "true";
        environment.NEW_RELIC_LOG = environment.NEW_RELIC_LOG
            ? environment.NEW_RELIC_LOG
            : isPython
                ? "stderr"
                : "stdout";
        if (!environment.NEW_RELIC_LOG_LEVEL) {
            const globalNewRelicLogLevel = _.get(this.serverless.service, "provider.environment.NEW_RELIC_LOG_LEVEL");
            if (globalNewRelicLogLevel) {
                environment.NEW_RELIC_LOG_LEVEL = globalNewRelicLogLevel;
            }
            else if (this.config.logLevel) {
                environment.NEW_RELIC_LOG_LEVEL = this.config.logLevel;
            }
            else if (this.config.debug) {
                environment.NEW_RELIC_LOG_LEVEL = "debug";
            }
            else {
                environment.NEW_RELIC_LOG_LEVEL = "error";
            }
        }
    }
    getLayerArn(runtime, architecture) {
        return __awaiter(this, void 0, void 0, function* () {
            const url = `https://${this.region}.layers.newrelic-external.com/get-layers?CompatibleRuntime=${runtime}`;
            return (0, node_fetch_1.default)(url)
                .then((response) => __awaiter(this, void 0, void 0, function* () {
                const awsResp = yield response.json();
                const layers = _.get(awsResp, "Layers", []);
                const compatibleLayers = layers
                    .map((layer) => {
                    const latestLayer = layer.LatestMatchingVersion;
                    const latestArch = latestLayer.CompatibleArchitectures;
                    const matchingArch = architecture && latestArch && architecture === latestArch[0];
                    const defaultArch = !architecture && (!latestArch || latestArch[0] === "x86_64");
                    if (matchingArch || defaultArch) {
                        return latestLayer;
                    }
                })
                    .filter((layer) => typeof layer !== "undefined");
                if (!compatibleLayers ||
                    (compatibleLayers.length < 1 && architecture)) {
                    this.log.warning(`${architecture} is not yet supported by New Relic layers for ${runtime} in ${this.region}. Skipping.`);
                    return false;
                }
                return compatibleLayers[0].LayerVersionArn;
            }))
                .catch((reason) => {
                this.log.error(`Unable to get layer ARN for ${runtime} in ${this.region}`);
                this.log.error(`URL: ${url}`);
                this.log.error(reason);
                return;
            });
        });
    }
    getHandlerWrapper(runtime, handler) {
        if (["nodejs12.x", "nodejs14.x", "nodejs16.x", "nodejs18.x"].indexOf(runtime) !== -1) {
            return "newrelic-lambda-wrapper.handler";
        }
        if (runtime.match("python")) {
            return "newrelic_lambda_wrapper.handler";
        }
        if (["java11", "java8.al2"].indexOf(runtime) !== -1) {
            return `com.newrelic.java.HandlerWrapper::${this.javaNewRelicHandler}`;
        }
        return handler;
    }
    updatePackageExcludes(runtime, pkg) {
        if (!runtime.match("nodejs")) {
            return pkg;
        }
        const { exclude = [] } = pkg;
        exclude.push("!newrelic-wrapper-helper.js");
        pkg.exclude = exclude;
        return pkg;
    }
    ensureLogSubscription(funcName, cloudWatchFilterString) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield this.awsProvider.request("Lambda", "getFunction", {
                    FunctionName: funcName,
                });
            }
            catch (err) {
                if (err.providerError) {
                    this.log.error(err.providerError.message);
                }
                return;
            }
            let destinationArn;
            const { logIngestionFunctionName = "newrelic-log-ingestion", apiKey } = this.config;
            try {
                destinationArn = yield this.getDestinationArn(logIngestionFunctionName);
            }
            catch (err) {
                this.log.error(`Could not find a \`${logIngestionFunctionName}\` function installed.`);
                this.log.warning("Details about setup requirements are available here: https://docs.newrelic.com/docs/serverless-function-monitoring/aws-lambda-monitoring/get-started/enable-new-relic-monitoring-aws-lambda#enable-process");
                if (err.providerError) {
                    this.log.error(err.providerError.message);
                }
                if (!apiKey) {
                    this.log.error("Unable to create newrelic-log-ingestion because New Relic API key not configured.");
                    return;
                }
                this.log.notice(`creating required newrelic-log-ingestion function in region ${this.region}`);
                yield this.addLogIngestionFunction();
                return;
            }
            let subscriptionFilters;
            try {
                subscriptionFilters = yield this.describeSubscriptionFilters(funcName);
            }
            catch (err) {
                if (err.providerError) {
                    this.log.error(err.providerError.message);
                }
                return;
            }
            const competingFilters = subscriptionFilters.filter((filter) => filter.filterName !== "NewRelicLogStreaming");
            if (competingFilters.length) {
                this.log.warning("WARNING: Found a log subscription filter that was not installed by New Relic. This may prevent the New Relic log subscription filter from being installed. If you know you don't need this log subscription filter, you should first remove it and rerun this command. If your organization requires this log subscription filter, please contact New Relic at serverless@newrelic.com for assistance with getting the AWS log subscription filter limit increased.");
            }
            const existingFilters = subscriptionFilters.filter((filter) => filter.filterName === "NewRelicLogStreaming");
            if (existingFilters.length) {
                this.log.notice(`Found log subscription for ${funcName}, verifying configuration`);
                yield Promise.all(existingFilters
                    .filter((filter) => filter.filterPattern !== cloudWatchFilterString)
                    .map((filter) => __awaiter(this, void 0, void 0, function* () { return this.removeSubscriptionFilter(funcName); }))
                    .map((filter) => __awaiter(this, void 0, void 0, function* () {
                    return this.addSubscriptionFilter(funcName, destinationArn, cloudWatchFilterString);
                })));
            }
            else {
                this.log.notice(`Adding New Relic log subscription to ${funcName}`);
                yield this.addSubscriptionFilter(funcName, destinationArn, cloudWatchFilterString);
            }
        });
    }
    getDestinationArn(logIngestionFunctionName) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                return this.awsProvider
                    .request("Lambda", "getFunction", {
                    FunctionName: logIngestionFunctionName,
                })
                    .then((res) => res.Configuration.FunctionArn);
            }
            catch (e) {
                this.log.error(`Error getting ingestion function destination ARN.`);
                this.log.error(e);
            }
        });
    }
    addLogIngestionFunction() {
        return __awaiter(this, void 0, void 0, function* () {
            const templateUrl = yield this.getSarTemplate();
            if (!templateUrl) {
                this.log.error("Unable to create newRelic-log-ingestion without sar template.");
                return;
            }
            try {
                const mode = "CREATE";
                const stackName = "NewRelicLogIngestion";
                const changeSetName = `${stackName}-${mode}-${Date.now()}`;
                const parameters = yield this.formatFunctionVariables();
                const params = {
                    Capabilities: ["CAPABILITY_IAM"],
                    ChangeSetName: changeSetName,
                    ChangeSetType: mode,
                    Parameters: parameters,
                    StackName: stackName,
                    TemplateURL: templateUrl,
                };
                let cfResponse;
                try {
                    cfResponse = yield this.awsProvider.request("CloudFormation", "createChangeSet", params);
                }
                catch (e) {
                    this.log.error(`Unable to get stack information.`);
                    this.log.error(e);
                }
                const { Id, StackId } = cfResponse;
                this.log.notice("Waiting for change set creation to complete, this may take a minute...");
                yield (0, utils_1.waitForStatus)({
                    awsMethod: "describeChangeSet",
                    callbackMethod: () => this.executeChangeSet(Id, StackId),
                    methodParams: { ChangeSetName: Id },
                    statusPath: "Status",
                }, this);
            }
            catch (err) {
                this.log.warning("Unable to create newrelic-log-ingestion function. Please verify that required environment variables have been set.");
            }
        });
    }
    retrieveLicenseKey() {
        return __awaiter(this, void 0, void 0, function* () {
            const { apiKey, accountId, nrRegion, proxy } = this.config;
            const userData = yield (0, api_1.nerdgraphFetch)(apiKey, nrRegion, (0, api_1.fetchLicenseKey)(accountId), proxy, { serverless: this.serverless, caller: "retrieveLicenseKey" });
            this.licenseKey = _.get(userData, "data.actor.account.licenseKey", null);
            return this.licenseKey;
        });
    }
    formatFunctionVariables() {
        return __awaiter(this, void 0, void 0, function* () {
            const { logEnabled } = this.config;
            const licenseKey = this.licenseKey
                ? this.licenseKey
                : yield this.retrieveLicenseKey();
            const loggingVar = logEnabled ? "True" : "False";
            return [
                {
                    ParameterKey: "NRLoggingEnabled",
                    ParameterValue: `${loggingVar}`,
                },
                {
                    ParameterKey: "NRLicenseKey",
                    ParameterValue: `${licenseKey}`,
                },
            ];
        });
    }
    getSarTemplate() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const data = yield this.awsProvider.request("ServerlessApplicationRepository", "createCloudFormationTemplate", {
                    ApplicationId: "arn:aws:serverlessrepo:us-east-1:463657938898:applications/NewRelic-log-ingestion",
                });
                const { TemplateUrl } = data;
                return TemplateUrl;
            }
            catch (err) {
                this.log.error(`Something went wrong while fetching the sar template: ${err}`);
            }
        });
    }
    executeChangeSet(changeSetName, stackId) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield this.awsProvider.request("CloudFormation", "executeChangeSet", {
                    ChangeSetName: changeSetName,
                });
                this.log.notice("Waiting for newrelic-log-ingestion install to complete, this may take a minute...");
                yield (0, utils_1.waitForStatus)({
                    awsMethod: "describeStacks",
                    callbackMethod: () => this.addLogSubscriptions(),
                    methodParams: { StackName: stackId },
                    statusPath: "Stacks[0].StackStatus",
                }, this);
            }
            catch (changeSetErr) {
                this.log.error(`Something went wrong while executing the change set: ${changeSetErr}`);
            }
        });
    }
    describeSubscriptionFilters(funcName) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.awsProvider
                .request("CloudWatchLogs", "describeSubscriptionFilters", {
                logGroupName: `/aws/lambda/${funcName}`,
            })
                .then((res) => res.subscriptionFilters);
        });
    }
    addSubscriptionFilter(funcName, destinationArn, cloudWatchFilterString) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.awsProvider
                .request("CloudWatchLogs", "putSubscriptionFilter", {
                destinationArn,
                filterName: "NewRelicLogStreaming",
                filterPattern: cloudWatchFilterString,
                logGroupName: `/aws/lambda/${funcName}`,
            })
                .catch((err) => {
                if (err.providerError) {
                    this.log.error(err.providerError.message);
                }
            });
        });
    }
    removeSubscriptionFilter(funcName) {
        return this.awsProvider
            .request("CloudWatchLogs", "DeleteSubscriptionFilter", {
            filterName: "NewRelicLogStreaming",
            logGroupName: `/aws/lambda/${funcName}`,
        })
            .catch((err) => {
            if (err.providerError) {
                this.log.error(err.providerError.message);
            }
        });
    }
}
exports.default = NewRelicLambdaLayerPlugin;
module.exports = NewRelicLambdaLayerPlugin;

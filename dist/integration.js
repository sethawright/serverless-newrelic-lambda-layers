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
const api_1 = require("./api");
const utils_1 = require("./utils");
class Integration {
    constructor({ config, awsProvider, serverless, region, licenseKey, log, }) {
        this.config = config;
        this.log = log;
        this.awsProvider = awsProvider;
        this.serverless = serverless;
        this.region = region;
        this.licenseKey = licenseKey;
    }
    check() {
        return __awaiter(this, void 0, void 0, function* () {
            const { accountId, enableIntegration, apiKey, nrRegion, proxy } = this.config;
            const integrationData = yield (0, api_1.nerdgraphFetch)(apiKey, nrRegion, (0, api_1.fetchLinkedAccounts)(accountId), proxy, {
                caller: "check integration for linked accounts",
                serverless: this.serverless,
            });
            const linkedAccounts = _.get(integrationData, "data.actor.account.cloud.linkedAccounts", []);
            const externalId = yield this.getCallerIdentity();
            const match = linkedAccounts.filter((account) => {
                return (account &&
                    account.externalId === externalId &&
                    account.nrAccountId === parseInt(accountId, 10));
            });
            if (match.length < 1) {
                this.log.warning("No New Relic AWS Lambda integration found for this New Relic linked account and aws account.");
                if (enableIntegration &&
                    (enableIntegration !== "false" || enableIntegration !== false)) {
                    this.enable(externalId);
                    return;
                }
                this.log.notice("Please enable the configuration manually or add the 'enableIntegration' config var to your serverless.yaml file.");
                return;
            }
            this.log.notice("Existing New Relic integration found for this linked account and aws account, skipping creation.");
        });
    }
    checkForManagedSecretPolicy() {
        return __awaiter(this, void 0, void 0, function* () {
            const thisRegionPolicy = `NewRelic-ViewLicenseKey-${this.region}`;
            const regionFilter = (policy) => policy.PolicyName.match(thisRegionPolicy);
            try {
                const params = {
                    Scope: `Local`,
                };
                const results = yield this.awsProvider.request("IAM", "listPolicies", params);
                const currentRegionPolicy = results.Policies.filter(regionFilter);
                return {
                    currentRegionPolicy,
                    secretExists: currentRegionPolicy.length > 0,
                };
            }
            catch (err) {
                this.log.error(`Problem getting list of current policies. ${JSON.stringify(err)}`);
                return {};
            }
        });
    }
    createManagedSecret() {
        return __awaiter(this, void 0, void 0, function* () {
            const stackName = `NewRelicLicenseKeySecret`;
            const policyName = `NewRelic-ViewLicenseKey`;
            const externalId = yield this.getCallerIdentity();
            const policyArn = `arn:aws:iam::${externalId}:policy/${policyName}-${this.region}`;
            try {
                const policy = yield (0, utils_1.fetchPolicy)("nr-license-key-secret.yaml");
                const params = {
                    Capabilities: ["CAPABILITY_NAMED_IAM"],
                    Parameters: [
                        {
                            ParameterKey: "LicenseKey",
                            ParameterValue: this.licenseKey,
                        },
                        {
                            ParameterKey: "Region",
                            ParameterValue: this.region,
                        },
                        {
                            ParameterKey: "PolicyName",
                            ParameterValue: policyName,
                        },
                    ],
                    StackName: stackName,
                    TemplateBody: policy,
                };
                const { StackId } = yield this.awsProvider.request("CloudFormation", "createStack", params);
                return { stackId: StackId, stackName, policyName, policyArn };
            }
            catch (err) {
                // If the secret already exists, we'll see an error, but we populate
                // a return value anyway to avoid falling back to the env var.
                if (`${err}`.indexOf("NewRelicLicenseKeySecret") > -1 &&
                    `${err}`.indexOf("already exists") > -1) {
                    this.log.error(JSON.stringify(err));
                    return { stackId: "already created", stackName, policyName };
                }
                this.log.error(`Something went wrong while creating NewRelicLicenseKeySecret: ${err}`);
            }
            return false;
        });
    }
    enable(externalId) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const roleArn = yield this.checkAwsIntegrationRole(externalId);
                if (!roleArn) {
                    return;
                }
                const { accountId, apiKey, nrRegion, proxy } = this.config;
                const { linkedAccount = `New Relic Lambda Integration - ${accountId}` } = this.config;
                this.log.notice(`Enabling New Relic integration for linked account: ${linkedAccount} and aws account: ${externalId}.`);
                const res = yield (0, api_1.nerdgraphFetch)(apiKey, nrRegion, (0, api_1.cloudLinkAccountMutation)(accountId, roleArn, linkedAccount), proxy, {
                    caller: "enable integration, cloudLinkAccountMutation",
                    serverless: this.serverless,
                });
                const { linkedAccounts, errors } = _.get(res, "data.cloudLinkAccount", {
                    errors: ["data.cloudLinkAccount missing in response"],
                });
                if (errors && errors.length) {
                    throw new Error(JSON.stringify(errors));
                }
                const linkedAccountId = _.get(linkedAccounts, "[0].id");
                const integrationRes = yield (0, api_1.nerdgraphFetch)(apiKey, nrRegion, (0, api_1.cloudServiceIntegrationMutation)(accountId, "aws", "lambda", linkedAccountId), proxy, {
                    caller: "enable integration, cloudServiceIntegrationMutation",
                    serverless: this.serverless,
                });
                const { errors: integrationErrors } = _.get(integrationRes, "data.cloudConfigureIntegration", {
                    errors: ["data.cloudConfigureIntegration missing in response"],
                });
                if (integrationErrors && integrationErrors.length) {
                    throw new Error(JSON.stringify(integrationErrors));
                }
                this.log.notice(`New Relic AWS Lambda cloud integration created successfully.`);
            }
            catch (err) {
                this.log.error(`Error while creating the New Relic AWS Lambda cloud integration: ${err}.`);
            }
        });
    }
    getCallerIdentity() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { Account } = yield this.awsProvider.request("STS", "getCallerIdentity", {});
                return Account;
            }
            catch (err) {
                this.log.error("No AWS config found, please configure a default AWS config.");
            }
        });
    }
    requestRoleArn(RoleName) {
        return __awaiter(this, void 0, void 0, function* () {
            const params = {
                RoleName,
            };
            try {
                const response = yield this.awsProvider.request("IAM", "getRole", params);
                const { Role: { Arn }, } = response;
                return Arn;
            }
            catch (e) {
                if (e.code && e.code === "AWS_I_A_M_GET_ROLE_NO_SUCH_ENTITY") {
                    return null;
                }
                else {
                    // some other error; attempting creation will fail
                    this.log.warning(e);
                    return false;
                }
            }
        });
    }
    checkAwsIntegrationRole(externalId) {
        return __awaiter(this, void 0, void 0, function* () {
            const { accountId } = this.config;
            if (!accountId) {
                this.log.error("No New Relic Account ID specified; Cannot check for required NewRelicLambdaIntegrationRole.");
                return;
            }
            let roleArn = yield this.requestRoleArn(`NewRelicLambdaIntegrationRole_${accountId}`);
            if (roleArn || roleArn === false) {
                return roleArn;
            }
            this.log.warning(`NewRelicLambdaIntegrationRole_${accountId} not found. Creating Stack with NewRelicLambdaIntegrationRole.`);
            const stackId = yield this.createCFStack(accountId);
            (0, utils_1.waitForStatus)({
                awsMethod: "describeStacks",
                callbackMethod: () => this.enable(externalId),
                methodParams: {
                    StackName: stackId,
                },
                statusPath: "Stacks[0].StackStatus",
            }, this);
            try {
                roleArn = yield this.requestRoleArn(`NewRelicLambdaIntegrationRole_${accountId}`);
            }
            catch (e) {
                this.log.error("Unable to create integration role", e);
            }
            return roleArn;
        });
    }
    createCFStack(accountId) {
        return __awaiter(this, void 0, void 0, function* () {
            const stackName = `NewRelicLambdaIntegrationRole-${accountId}`;
            const { customRolePolicy = "" } = this.config;
            try {
                const policy = yield (0, utils_1.fetchPolicy)("nr-lambda-integration-role.yaml");
                const params = {
                    Capabilities: ["CAPABILITY_NAMED_IAM"],
                    Parameters: [
                        {
                            ParameterKey: "NewRelicAccountNumber",
                            ParameterValue: accountId.toString(),
                        },
                        { ParameterKey: "PolicyName", ParameterValue: customRolePolicy },
                    ],
                    StackName: stackName,
                    TemplateBody: policy,
                };
                const { StackId } = yield this.awsProvider.request("CloudFormation", "createStack", params);
                return StackId;
            }
            catch (err) {
                this.log.error(`Something went wrong while creating NewRelicLambdaIntegrationRole: ${JSON.stringify(err)}`);
            }
        });
    }
}
exports.default = Integration;

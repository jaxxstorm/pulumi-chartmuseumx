import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as kubernetes from "@pulumi/kubernetes"

// define the shape of the args
export interface ChartMuseumArgs {
    namespace?: string;
    replicas?: number;
    api?: boolean;
    metrics?: boolean;
    service?: {
        type: string
    }
}

// set some defaults
const ChartMuseumDefaults: ChartMuseumArgs = {
    namespace: "chartmuseum",
    replicas: 1,
    service: {
        type: "ClusterIP",
    },
    api: false,
    metrics: false,
}

const config = new pulumi.Config("chartmuseum")
const provider = config.require("provider")
const region = config.require("region")


export class ChartMuseum extends pulumi.ComponentResource {
    deployment: kubernetes.apps.v1.Deployment
    namespace: kubernetes.core.v1.Namespace
    service: kubernetes.core.v1.Service
    secret: kubernetes.core.v1.Secret
    bucket: aws.s3.Bucket
    cloudProvider: string
    cloudProviderRegion: string

    private readonly name: string
    private args: ChartMuseumArgs;
    private readonly api: string
    private readonly metrics: string

    constructor(name: string, args?: ChartMuseumArgs, opts?: pulumi.ComponentResourceOptions) {
        super("jaxxstorm:chartmuseum", name, {}, opts);

        this.name = name;
        this.args = {...ChartMuseumDefaults, ...args}
        this.api = String(!this.args.api) // the env var is "DISABLE_API" so we invert
        this.metrics = String(!this.args.metrics)

        const labels = {
            app: "chartmuseum",
            release: name,
        }

        this.namespace = new kubernetes.core.v1.Namespace(`chartmuseum-${name}-namespace`, {
            metadata: {
                name: this.args.namespace,
                labels: labels
            }
        }, {parent: this})

        switch (provider) {
            case "aws":
                this.bucket = new aws.s3.Bucket(`chartmuseum-${name}-bucket`, {}, {parent: this})

                let iamUser = new aws.iam.User(`chartmuseum-${name}-iam-user`, {
                    path: "/chartmuseum/"
                }, {parent: this})

                new aws.iam.UserPolicy(`chartmuseum-${name}-iam-policy`, {
                    user: iamUser.name,
                    policy: this.bucket.bucket.apply(bucketName => JSON.stringify({
                        Version: "2012-10-17",
                        Statement: [{
                            Sid: "AllowListObjects",
                            Effect: "Allow",
                            Action: ["s3:ListBucket"],
                            Resource: `arn:aws:s3:::${bucketName}`,
                        }, {
                            Sid: "AllowObjectsCRUD",
                            Effect: "Allow",
                            Action: [
                                "s3:DeleteObject",
                                "s3:GetObject",
                                "s3:PutObject"
                            ],
                            Resource: `arn:aws:s3:::${bucketName}/*`
                        }],
                    })),
                }, {parent: iamUser})
                const accessKey = new aws.iam.AccessKey(`chartmuseum-${name}-iam-accesskey`, {
                    user: iamUser.name
                }, {parent: iamUser})

                // register the secret with k8s and input the credentials
                this.secret = new kubernetes.core.v1.Secret(`chartmuseum-${name}-secret`, {
                    metadata: {
                        namespace: this.namespace.metadata.name,
                        labels: labels,
                    },
                    data: {
                        "AWS_ACCESS_KEY_ID": accessKey.id.apply(k => Buffer.from(k).toString("base64")),
                        "AWS_SECRET_ACCESS_KEY": accessKey.secret.apply(k => Buffer.from(k).toString("base64")),
                    }
                }, {parent: this.namespace})

                this.cloudProvider = "amazon"
                this.cloudProviderRegion = region
                break;
            default:
                throw new pulumi.RunError("Must specify a cloud provider")
                break;
        }

        this.deployment = new kubernetes.apps.v1.Deployment(`chartmuseum-${name}-deployment`, {
            metadata: {
                namespace: this.namespace.metadata.name,
                labels: labels
            },
            spec: {
                selector: {
                    matchLabels: labels
                },
                replicas: this.args.replicas,
                strategy: {
                    rollingUpdate: {
                        maxUnavailable: 0,
                    },
                    type: "RollingUpdate",
                },
                template: {
                    metadata: {
                        name: name,
                        labels: labels,
                    },
                    spec: {
                        securityContext: {
                            fsGroup: 1000,
                        },
                        containers: [{
                            name: "chartmuseum",
                            image: "chartmuseum/chartmuseum:v0.12.0",
                            imagePullPolicy: "IfNotPresent",
                            env: [
                                {
                                    name: "DISABLE_API",
                                    value: this.api,
                                },
                                {
                                    name: "DISABLE_METRICS",
                                    value: this.metrics,
                                },
                                {
                                    name: "LOG_JSON",
                                    value: "true",
                                },
                                {
                                    name: "PROV_POST_FORM_FIELD_NAME",
                                    value: "prov",
                                },
                                {
                                    name: "STORAGE",
                                    value: this.cloudProvider
                                },
                                {
                                    name: `STORAGE_${this.cloudProvider.toUpperCase()}_REGION`,
                                    value: this.cloudProviderRegion
                                },
                                {
                                    name: `STORAGE_${this.cloudProvider.toUpperCase()}_BUCKET`,
                                    value: this.bucket.bucket,
                                },
                                {
                                    name: "AWS_ACCESS_KEY_ID",
                                    valueFrom: {
                                        secretKeyRef: {
                                            name: this.secret.metadata.name,
                                            key: "AWS_ACCESS_KEY_ID"
                                        }
                                    }
                                },
                                {
                                    name: "AWS_SECRET_ACCESS_KEY",
                                    valueFrom: {
                                        secretKeyRef: {
                                            name: this.secret.metadata.name,
                                            key: "AWS_SECRET_ACCESS_KEY"
                                        }
                                    }
                                }
                            ],
                            args: [
                                "--port=8080",
                            ],
                            ports: [{
                                name: "http",
                                containerPort: 8080,
                            }],
                            livenessProbe: {
                                httpGet: {
                                    path: "/health",
                                    port: "http",
                                },
                                failureThreshold: 3,
                                initialDelaySeconds: 5,
                                periodSeconds: 10,
                                successThreshold: 1,
                                timeoutSeconds: 1,
                            },
                            readinessProbe: {
                                httpGet: {
                                    path: "/health",
                                    port: "http",
                                },
                                failureThreshold: 3,
                                initialDelaySeconds: 5,
                                periodSeconds: 10,
                                successThreshold: 1,
                                timeoutSeconds: 1,
                            },
                        }],
                        volumes: [{
                            name: "storage-volume",
                            emptyDir: {},
                        }],
                    },
                },
            },
        }, {parent: this.namespace, dependsOn: this.bucket});

        this.service = new kubernetes.core.v1.Service(`chartmuseum-${name}-service`, {
            metadata: {
                labels: labels,
                namespace: this.namespace.metadata.name,
            },
            spec: {
                type: this.args.service?.type,
                ports: [{
                    port: 80,
                    targetPort: "http",
                    protocol: "TCP",
                    name: "http",
                }],
                selector: labels,
            }
        }, {parent: this.namespace})


    }
}

import {ComponentResource, ComponentResourceOptions, Input, Output} from "@pulumi/pulumi";
import {s3} from "@pulumi/aws";
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
    storage: {
        cloud: string,
        region: string,
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
    storage: {
        cloud: "amazon",
        region: "us-west-2",
    }
}

export class ChartMuseum extends ComponentResource {
    deployment: kubernetes.apps.v1.Deployment
    namespace: kubernetes.core.v1.Namespace
    service: kubernetes.core.v1.Service
    bucket: s3.Bucket

    private readonly name: string
    private args: ChartMuseumArgs;
    private readonly api: string
    private readonly metrics: string

    constructor(name: string, args?: ChartMuseumArgs, opts?: ComponentResourceOptions) {
        super("jaxxstorm:chartmuseum", name, {}, opts);

        this.name = name;
        this.args = { ...ChartMuseumDefaults, ...args}
        this.api = String(!this.args.api) // the env var is "DISABLE_API" so we invert
        this.metrics = String(!this.args.metrics)

        const labels = {
            app: "chartmuseum",
            release: name,
        }

        this.bucket = new s3.Bucket(`${name}-bucket`, {}, { parent: this })

        this.namespace = new kubernetes.core.v1.Namespace(`${name}-namespace`, {
            metadata: {
                name: this.args.namespace,
                labels: labels
            }
        }, { parent: this})

        this.deployment = new kubernetes.apps.v1.Deployment(`${name}-deployment`, {
            metadata: {
                namespace: this.namespace.metadata.name,
                name: name,
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
                                    value: this.args.storage.cloud
                                },
                                {
                                    name: `STORAGE_${this.args.storage.region.toUpperCase()}_REGION`,
                                    value: this.args.storage.region
                                },
                                {
                                    name: `STORAGE_${this.args.storage.cloud.toUpperCase()}_BUCKET`,
                                    value: this.bucket.bucket,
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
                            volumeMounts: [{
                                mountPath: "/storage",
                                name: "storage-volume",
                            }],
                        }],
                        volumes: [{
                            name: "storage-volume",
                            emptyDir: {},
                        }],
                    },
                },
            },
        }, {parent: this.namespace, dependsOn: this.bucket});

        this.service = new kubernetes.core.v1.Service(`${name}-service`, {
            metadata: {
                name: this.name,
                labels: labels,
            },
            spec: {
                type: this.args.service?.type,
                ports: [{
                    port: 8080,
                    targetPort: "http",
                    protocol: "TCP",
                    name: "http",
                }],
                selector: labels,
            }
        }, {parent: this.namespace})


    }
}

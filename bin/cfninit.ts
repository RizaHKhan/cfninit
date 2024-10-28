#!/usr/bin/env node
import "source-map-support/register";
import { App } from "aws-cdk-lib";
import { CfninitStack } from "../lib/cfninit-stack";

const app = new App();
new CfninitStack(app, "CfninitStack", {});

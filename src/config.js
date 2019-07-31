const YAML = require('yaml');
const path = require('path');
const { URL } = require('url');
const fs = require('fs-extra');
const { execFile } = require('child_process');
const { promisify } = require('util');
const argsparse = require('yargs-parser');
const Joi = require('@hapi/joi');
const { partition, template } = require('lodash');

const ENV = require('./environment').default;

const execFileAsync = promisify(execFile);

function checkUniqueField(field) {
  return (v1, v2) => {
    let curV1 = v1;

    if (typeof curV1 === 'string') {
      curV1 = { [field]: curV1 };
    }

    let curV2 = v2;

    if (typeof curV2 === 'string') {
      curV2 = { [field]: curV2 };
    }

    return curV1[field] === curV2[field] || curV1[field] === curV2[field];
  };
}

const argsSchema = Joi.array().min(1);

const onChangeCmdSchema = Joi.array().min(1);

const onChangeSchema = Joi.alternatives().try([
  onChangeCmdSchema,
  Joi.object({
    command: onChangeCmdSchema,
    stdout: Joi.boolean().default(false),
    stderr: Joi.boolean().default(true),
  }),
]);

const DataSourceSchema = Joi.alternatives().try([
  Joi.string().required(),
  Joi.object({
    url: Joi.string().uri().required(),
    alias: Joi.string().alphanum(),
    on_change: onChangeSchema,
    args: argsSchema,
  }),
]);

const FileSchema = Joi.alternatives().try([
  Joi.string().required(),
  Joi.object({
    left_delimiter: Joi.string(),
    right_delimiter: Joi.string(),
    input_path: Joi.string().required(),
    output_path: Joi.string(),
    on_change: onChangeSchema,
    args: argsSchema,
  }),
]);

const FilePathSchema = Joi.alternatives().try([
  Joi.string().required(),
  Joi.object({
    path: Joi.string().required(),
    on_change: onChangeSchema,
    args: argsSchema,
  }),
]);

const ConfigItemSchema = Joi.object({
  watch: Joi.boolean().default(false),
  dependencies: Joi.array().items(FilePathSchema).unique(checkUniqueField('path')).default([]),
  templates: Joi.array().items(FilePathSchema).unique(checkUniqueField('path')).default([]),
  datasources: Joi.array().items(DataSourceSchema).unique(checkUniqueField('url')).default([]),
  files: Joi.array().items(FileSchema).default([]).unique(checkUniqueField('input_path')),
  on_change: onChangeSchema,
  args: argsSchema,
});

const ConfigSchema = Joi.array()
  .items(ConfigItemSchema)
  .single(true)
  .min(1);

const templateInterpolateReg = /\[([\w]+?)\]/g;

function getPathFromArg(arg, v) {
  if (['t', 'f'].includes(arg)) {
    return v;
  }

  if (arg === 'd') {
    const curUrl = new URL(v.substring(v.indexOf('=') + 1));

    if (!curUrl.protocol.startsWith('file')) return null;

    return curUrl.pathname;
  }

  return null;
}

async function getConfig() {
  if (ENV.CONFIG_TEMPLATE_ARGS) {
    const args = argsparse(ENV.CONFIG_TEMPLATE_ARGS);

    if (process.env.CONFIG_PATH) {
      if (args.f) {
        throw new Error(`Use either CONFIG_PATH env or "-f" option of CONFIG_TEMPLATE_ARGS env [${ENV.CONFIG_TEMPLATE_ARGS}] but not both`);
      }

      args.f = value.CONFIG_PATH;
    }

    const cmd = args._[0];
    const configDeps = new Set();

    delete args._;

    const cmdArgs = Object.keys(args).reduce((arr, k) => {
      const curVal = args[k];

      if (Array.isArray(curVal)) {
        curVal.forEach(v => {
          const depPath = getPathFromArg(k, v);

          if (depPath) {
            configDeps.add(depPath);
          }

          arr.push(`-${k}`, v);
        });
      } else {
        const depPath = getPathFromArg(k, curVal);

        if (depPath) {
          configDeps.add(depPath);
        }

        arr.push(`-${k}`, curVal);
      }

      return arr;
    }, []);

    if (!cmdArgs.length) {
      throw new Error('CONFIG_TEMPLATE_ARGS env requires at least one argument');
    }

    const { stdout } = await execFileAsync(cmd, cmdArgs);

    return {
      config: stdout,
      configDeps: [...configDeps],
    };
  } else {
    const { dir, name } = path.parse(ENV.CONFIG_PATH);
    const curPath = path.join(dir, name);

    let conf = null;

    try {
      conf = await fs.readFile(`${curPath}.yaml`, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }

    conf = await fs.readFile(`${curPath}.yml`, 'utf8');

    return {
      config: conf,
      configDeps: [curPath],
    };
  }
}

function mapOnChange(v) {
  if (Array.isArray(v)) {
    return {
      command: v,
      stdout: false,
      stderr: true,
    };
  }

  return v;
}

function mapDataSource(v) {
  const curV = {
    url: null,
  };

  if (typeof v === 'string') {
    curV.url = v;
  } else {
    Object.assign(curV, v);
  }

  if (curV.on_change) {
    curV.on_change = mapOnChange(curV.on_change);
  }

  const curUrl = new URL(curV.url);

  if (curUrl.protocol.startsWith('file')) {
    curV.path = curUrl.pathname;
    curV.makeAlias = template(curV.alias, { interpolate: templateInterpolateReg });
  }

  return curV;
}

function mapFile(v) {
  const curV = {
    input_path: null,
  };

  if (typeof v === 'string') {
    curV.input_path = v;
  } else {
    Object.assign(curV, v);
  }

  if (curV.on_change) {
    curV.on_change = mapOnChange(curV.on_change);
  }

  if (curV.output_path) {
    curV.makeOutputPath = template(curV.output_path, { interpolate: templateInterpolateReg });
  }

  return curV;
}

function mapFilePath(v) {
  const curV = {
    path: null,
  };

  if (typeof v === 'string') {
    curV.path = v;
  } else {
    Object.assign(curV, v);
  }

  if (curV.on_change) {
    curV.on_change = mapOnChange(curV.on_change);
  }

  return curV;
}

function parseConfig(conf) {
  let curData = YAML.parse(conf);

  const { value, error } = ConfigSchema.validate(curData, {
    abortEarly: false,
    allowUnknown: false,
    stripUnknown: {
      arrays: false,
      objects: true,
    },
  });

  if (error) {
    throw error;
  }

  return value.map(item => {
    if (item.on_change) {
      item.on_change = mapOnChange(item.on_change);
    }

    const datasources = item.datasources.map(v => mapDataSource(v));

    [item.fileDataSources, item.otherDataSources] = partition(datasources, v => v.path != null);

    item.dependencies = item.dependencies.map(v => mapFilePath(v));
    item.templates = item.templates.map(v => mapFilePath(v));
    item.files = item.files.map(v => mapFile(v));

    return item;
  });
}

module.exports.getConfig = getConfig;
module.exports.parseConfig = parseConfig;

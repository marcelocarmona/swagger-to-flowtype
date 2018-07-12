#! /usr/bin/env node
// @flow
import program from "commander";
import prettier from "prettier";
import yaml from "js-yaml";
import fs from "fs";
import path from "path";
import axios from "axios";

// Swagger data types are base on types supported by the JSON-Scheme Draft4.
const typeMapping = {
  array: "Array<*>",
  boolean: "boolean",
  integer: "number",
  number: "number",
  null: "null",
  object: "Object",
  Object: "Object",
  string: "string",
  enum: "string"
};

const definitionTypeName = (ref): string => {
  const re = /#\/definitions\/(.*)|#\/components\/schemas\/(.*)/;
  const found = ref.match(re);
  if (!found) {
    return "";
  }
  return found[1] || found[2];
};

const stripBrackets = (name: string) => name.replace(/[[\]']+/g, "");

const typeFor = (property: any): string => {
  if (property.type === "array") {
    if ("oneOf" in property.items) {
      return `Array<${property.items.oneOf
        .map(
          e =>
            e.type === "object"
              ? propertiesTemplate(propertiesList(e.items)).replace(/"/g, "")
              : typeFor(e)
        )
        .join(" | ")}>`;
    } else if ("$ref" in property.items) {
      return `Array<${definitionTypeName(property.items.$ref)}>`;
    } else if (property.items.type === "object") {
      const child = propertiesTemplate(propertiesList(property.items)).replace(
        /"/g,
        ""
      );
      return `Array<${child}>`;
    }
    return `Array<${typeMapping[property.items.type]}>`;
  } else if (property.type === "string" && "enum" in property) {
    return property.enum.map(e => `'${e}'`).join(" | ");
  }
  return typeMapping[property.type] || definitionTypeName(property.$ref);
};

const isRequired = (propertyName: string, definition: Object): boolean => {
  const result =
    definition.required && definition.required.indexOf(propertyName) >= 0;
  return result;
};

const propertyKeyForDefinition = (
  propName: string,
  definition: Object
): string => {
  if (program.checkRequired) {
    return `${propName}${isRequired(propName, definition) ? "" : "?"}`;
  }
  return propName;
};

const propertiesList = (definition: Object) => {
  if ("allOf" in definition) {
    return definition.allOf.map(propertiesList);
  }

  if (definition.$ref) {
    return { $ref: definitionTypeName(definition.$ref) };
  }

  if ("type" in definition && definition.type !== "object") {
    return typeFor(definition);
  }

  if (
    !definition.properties ||
    Object.keys(definition.properties).length === 0
  ) {
    return {};
  }
  return Object.assign.apply(
    null,
    Object.keys(definition.properties).reduce(
      (properties: Array<Object>, propName: string) => {
        const arr = properties.concat({
          [propertyKeyForDefinition(propName, definition)]: typeFor(
            definition.properties[propName]
          )
        });
        return arr;
      },
      [{}]
    )
  );
};

// Generate imports
const importsList = (definition: Object) => {
  if (!definition.properties) return [];
  return Object.values(definition.properties).reduce((acc, value) => {
    if (value && value.$ref) {
      return [...acc, definitionTypeName(value.$ref)];
    }
    if (value && value.type === "array" && value.items && value.items.$ref) {
      return [...acc, definitionTypeName(value.items.$ref)];
    }
    return acc;
  }, []);
};

const withExact = (property: string): string => {
  const result = property.replace(/{[^|]/g, "{|").replace(/[^|]}/g, "|}");
  return result;
};

const propertiesTemplate = (
  properties: Object | Array<Object> | string
): string => {
  if (typeof properties === "string") {
    return properties;
  }
  if (Array.isArray(properties)) {
    return properties
      .map(property => {
        let p = property.$ref ? `& ${property.$ref}` : JSON.stringify(property);
        if (!property.$ref && program.exact) {
          p = withExact(p);
        }
        return p;
      })
      .sort(a => (a[0] === "&" ? 1 : -1))
      .join(" ");
  }
  if (program.exact) {
    return withExact(JSON.stringify(properties));
  }
  return JSON.stringify(properties);
};

const generate = (swagger: Object): string => {
  let defs;
  if (swagger.definitions) {
    defs = swagger.definitions;
  } else if (swagger.components) {
    defs = swagger.components.schemas;
  }
  if (!defs) {
    throw new Error("There is no definition");
  }

  let g = Object.keys(defs).reduce(
    (acc: Array<Object>, definitionName: string) => {
      const arr = acc.concat({
        title: stripBrackets(definitionName),
        properties: propertiesList(defs[definitionName])
      });
      return arr;
    },
    []
  );

  g = g.map(definition => {
    const s = `export type ${definition.title} = ${propertiesTemplate(
      definition.properties
    ).replace(/"/g, "")};`;
    return s;
  });

  g.join(" ");
  return g;
};

// remove « and »
// https://github.com/swagger-api/swagger-core/issues/498
const removeGenericsBug = (value: string) =>
  value
    .split("«")
    .join("")
    .split("»")
    .join("");

const generatorArray = (swagger: Object): Array<any> => {
  let defs;
  if (swagger.definitions) {
    defs = swagger.definitions;
  } else if (swagger.components) {
    defs = swagger.components.schemas;
  }
  if (!defs) {
    throw new Error("There is no definition");
  }

  return Object.keys(defs).reduce(
    (acc: Array<Object>, definitionName: string) => {
      const arr = acc.concat({
        title: stripBrackets(removeGenericsBug(definitionName)),
        properties: propertiesList(defs[definitionName]),
        imports: importsList(defs[definitionName])
      });
      return arr;
    },
    []
  );
};

const importTemplate = (typeName: string): string =>
  `import type { ${typeName} } from './${typeName}';`;

const importTemplates = (definition: Object): string =>
  Array.from(new Set(definition.imports))
    .map(prop => importTemplate(prop))
    .join("\n");

const generateTypeFile = (definition: Object): string => {
  const s = `export type ${definition.title} = ${propertiesTemplate(
    definition.properties
  ).replace(/"/g, "")};`;
  return importTemplates(definition) + s;
};

export const generator = (content: Object, file: string) => {
  const options = prettier.resolveConfig.sync(file) || {};
  const result = `// @flow\n${generate(content)}`;
  return prettier.format(result, options);
};

export const writeToFile = (dist: string = "./flowtype.js", result: string) => {
  fs.writeFile(dist, result, err => {
    if (err) {
      throw err;
    }
  });
};

export const isUrl = (value: string): boolean =>
  value.match(/https?:\/\//) !== null;

export const distFile = (p: Object, inputFileName: string): string => {
  if (p.destination) {
    return p.destination;
  }
  if (isUrl(inputFileName)) {
    return "./flowtype.js";
  }

  const ext = path.parse(inputFileName).ext;
  return inputFileName.replace(ext, ".js");
};

export const getContentFromFile = (file: string): Object => {
  const ext = path.extname(file);
  const readFile = fs.readFileSync(file, "utf8");
  return ext === ".yaml" ? yaml.safeLoad(readFile) : JSON.parse(readFile);
};

export const isObject = (value: any): boolean =>
  typeof value === "object" && value !== null;

export const getContentFromUrl = (url: string): Promise<Object> =>
  axios({
    method: "get",
    url
  }).then(response => {
    const { data } = response;
    return isObject(data) ? data : yaml.safeLoad(data);
  });

export const getContent = (fileOrUrl: string): Promise<Object> => {
  if (isUrl(fileOrUrl)) {
    return getContentFromUrl(fileOrUrl);
  }
  const content = getContentFromFile(fileOrUrl);
  return Promise.resolve(content);
};

program
  .arguments("<file>")
  .option("-d --destination <destination>", "Destination path")
  .option("-cr --check-required", "Add question mark to optional properties")
  .option("-e --exact", "Add exact types")
  .action(async file => {
    try {
      const content = await getContent(file);
      const dist = distFile(program, file);
      const results = generatorArray(content);
      results.forEach(definition => {
        const fileName = `${dist}/${removeGenericsBug(definition.title)}.js`;
        let finalResult = removeGenericsBug(generateTypeFile(definition));
        const options = prettier.resolveConfig.sync(file) || {
          parser: "babylon"
        };
        finalResult = `// @flow\n${finalResult}`;
        finalResult = prettier.format(finalResult, options);
        console.log(`Generated -> ${fileName}`);
        writeToFile(fileName, finalResult);
      });

      // index file
      const imports = results.map(definition => {
        const s = `import type { ${definition.title} as _${
          definition.title
        } } from './${definition.title}';`;
        return s;
      });

      const exports = results.map(definition => {
        const s = `export type ${definition.title} = _${definition.title};`;
        return s;
      });
      const indexFile = "// @flow\n".concat(
        [...imports, " ", ...exports].join("\n").concat("\n")
      );

      writeToFile(`${dist}/index.js`, indexFile);

      console.log("Generated flow types");
    } catch (e) {
      console.log(e);
    }
  })
  .parse(process.argv);

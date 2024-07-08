import fs from 'fs';
import path from 'path';
const debug = (await import('debug')).default('convert');

const devProxyRandomErrors = {
  "errors": []
};
let postmanCollection = {};

function isFolder(itemOrFolder) {
  return itemOrFolder.hasOwnProperty('item');
}

function processItem(item) {
  const errResponses = item.response.filter(response => response.code >= 400);
  if (errResponses.length === 0) {
    debug(`No error responses found for ${item.name}`);
    return;
  }
  debug(`Found ${errResponses.length} error responses for ${item.name}`)

  const devProxyErrorResponses = {
    request: {
      url: replaceUrlParams(replaceVariables(postmanCollection, item.request.url.raw)),
      method: item.request.method
    },
    responses: errResponses.map(errResponse => {
      return {
        statusCode: errResponse.code,
        body: JSON.parse(errResponse.body),
        headers: errResponse.header?.map(h => {
          return {
            name: h.key,
            value: h.value
          }
        })
      }
    })
  };

  devProxyRandomErrors.errors.push(devProxyErrorResponses);
}

function processItemOrFolder(itemOrFolder) {
  debug(`Processing item ${itemOrFolder.name}...`);

  if (isFolder(itemOrFolder)) {
    itemOrFolder.item.forEach(subItemOrFolder => processItemOrFolder(subItemOrFolder));
  }
  else {
    processItem(itemOrFolder);
  }
}

function convertCollectionToRandomErrors() {
  postmanCollection.item.forEach(itemOrFolder => processItemOrFolder(itemOrFolder));
}

function replaceVariables(collection, s) {
  debug(`Replacing variables in ${s}...`);
  let result = s;
  const matches = s.match(/{{(.*?)}}/g);
  if (!matches) {
    debug('No variables found');
    return result;
  }

  matches.forEach(match => {
    const variableName = match.substring(2, match.length - 2);
    result = replaceVariable(collection, result, variableName);
  });

  debug(`Replaced variables ${s} => ${result}`);

  return result;
}

function replaceUrlParams(url) {
  const replaced = url.replace(/:[^/]+/g, '*');
  debug(`Replaced url params ${url} => ${replaced}`);
  return replaced;
}

function replaceVariable(collection, s, variableName) {
  const variable = collection.variable.find(v => v.key === variableName);
  if (!variable) {
    variable = { value: '*' };
  }

  return s.replace(`{{${variableName}}}`, variable.value);
}

function pathToSection(outputPath) {
  return outputPath.split(path.sep).pop().toLowerCase();
}

function getLongestCommonUrl() {
  const commonPrefix = devProxyRandomErrors.errors.reduce((prefix, errorResponse) => {
    if (!prefix) {
      return errorResponse.request.url;
    }

    let i = 0;
    while (i < prefix.length && i < errorResponse.request.url.length && prefix[i] === errorResponse.request.url[i]) {
      i++;
    }

    return prefix.substring(0, i);
  }, '');
  return commonPrefix;
}

export function convert(inputFile, outputFolder) {
  postmanCollection = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  convertCollectionToRandomErrors(postmanCollection);

  if (devProxyRandomErrors.errors.length === 0) {
    debug('No error responses found in collection. Exiting...');
    return;
  }

  if (!fs.existsSync(outputFolder)) {
    debug(`Creating output folder ${outputFolder}...`);
    fs.mkdirSync(outputFolder, { recursive: true });
  }

  const collectionName = pathToSection(outputFolder);
  const errorsFileName = `errors-${collectionName}.json`;
  debug(`Writing errors file for ${collectionName} to ${errorsFileName}...`);
  // sort responses by URLs so that the longest URLs are first.
  // That way, the most specific URLs are matched first.
  devProxyRandomErrors.errors = devProxyRandomErrors.errors
    .sort((a, b) => b.request.url.length - a.request.url.length);
  fs.writeFileSync(path.join(outputFolder, errorsFileName), JSON.stringify(devProxyRandomErrors, null, 2));
  
  const sectionName = `errors${collectionName[0].toUpperCase()}${collectionName.substring(1)}`;
  const devProxyRc = {
    $schema: 'https://raw.githubusercontent.com/microsoft/dev-proxy/main/schemas/v0.20.0/rc.schema.json',
    plugins: [
      {
        name: 'RetryAfterPlugin',
        enabled: true,
        pluginPath: '~appFolder/plugins/dev-proxy-plugins.dll'
      },
      {
        name: 'GenericRandomErrorPlugin',
        enabled: true,
        pluginPath: '~appFolder/plugins/dev-proxy-plugins.dll',
        configSection: sectionName
      }
    ],
    urlsToWatch: [getLongestCommonUrl() + '*'],
    rate: 50,
    logLevel: 'information',
    newVersionNotification: 'stable'
  };
  devProxyRc[sectionName] = {
    errorsFile: errorsFileName
  };

  const rcFile = path.join(outputFolder, 'devproxyrc.json');
  debug(`Writing rc file to ${rcFile}...`);
  fs.writeFileSync(rcFile, JSON.stringify(devProxyRc, null, 2));
}
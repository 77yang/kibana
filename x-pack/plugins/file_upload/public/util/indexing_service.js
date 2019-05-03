/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { http } from './http_service';
import chrome from 'ui/chrome';
import { chunk } from 'lodash';
import { i18n } from '@kbn/i18n';
import { indexPatternService } from '../../../maps/public/kibana_services';
import { getGeoJsonIndexingDetails } from './geo_processing';

const CHUNK_SIZE = 10000;
const IMPORT_RETRIES = 5;
const basePath = chrome.addBasePath('/api/fileupload');
const fileType = 'json';

export async function indexData(parsedFile, transformDetails, indexName, dataType, appName) {
  if (!parsedFile) {
    throw('No file imported');
    return;
  }

  // Perform any processing required on file prior to indexing
  const transformResult = transformDataByFormatForIndexing(transformDetails, parsedFile, dataType);
  if (!transformResult.success) {
    throw `Error transforming data: ${transformResult.error}`;
  }

  // Create new index
  const { indexingDetails } = transformResult;
  const createdIndex = await writeToIndex({
    appName,
    ...indexingDetails,
    id: undefined,
    data: [],
    index: indexName,
  });
  const { id } = createdIndex;
  if (!id) {
    throw `Error creating index`;
  }

  // Write to index
  const indexWriteResults = await chunkDataAndWriteToIndex({
    id,
    index: indexName,
    ...indexingDetails,
    settings: {},
    mappings: {},
  });
  return indexWriteResults;
}


function transformDataByFormatForIndexing(transform, parsedFile, dataType) {
  let indexingDetails;
  if (!transform) {
    return {
      success: false,
      error: 'No transform defined',
    };
  }
  if (typeof transform !== 'object') {
    switch(transform) {
      case 'geo':
        indexingDetails = getGeoJsonIndexingDetails(parsedFile, dataType);
        break;
      default:
        return {
          success: false,
          error: `No handling defined for transform: ${transform}`
        };
    }
  } else { // Custom transform
    indexingDetails = transform.getIndexingDetails(parsedFile);
  }
  return indexingDetails
    ? {
      success: true,
      indexingDetails
    }
    : {
      success: false,
      error: `Unknown error performing transform: ${transform}`,
    };
}

function writeToIndex(indexingDetails) {
  const paramString = (indexingDetails.id !== undefined) ? `?id=${indexingDetails.id}` : '';
  const {
    appName,
    index,
    data,
    settings,
    mappings,
    ingestPipeline
  } = indexingDetails;

  return http({
    url: `${basePath}/import${paramString}`,
    method: 'POST',
    data: {
      index,
      data,
      settings,
      mappings,
      ingestPipeline,
      fileType,
      ...(appName ? { app: appName } : {})
    },
  });
}

async function chunkDataAndWriteToIndex({ id, index, data, mappings, settings }) {
  if (!index) {
    return {
      success: false,
      error: i18n.translate('xpack.file_upload.noIndexSuppliedErrorMessage', {
        defaultMessage: 'No index supplied'
      })
    };
  }

  const chunks = chunk(data, CHUNK_SIZE);

  let success = true;
  let failures = [];
  let error;
  let docCount = 0;

  for (let i = 0; i < chunks.length; i++) {
    const aggs = {
      id,
      index,
      data: chunks[i],
      settings,
      mappings,
      ingestPipeline: {} // TODO: Support custom ingest pipelines
    };

    let retries = IMPORT_RETRIES;
    let resp = {
      success: false,
      failures: [],
      docCount: 0,
    };

    while (resp.success === false && retries > 0) {
      resp = await writeToIndex(aggs);

      if (retries < IMPORT_RETRIES) {
        console.log(`Retrying import ${IMPORT_RETRIES - retries}`);
      }

      retries--;
    }
    failures = [...failures, ...resp.failures];

    if (resp.success) {
      docCount = resp.docCount;
    } else {
      console.error(resp);
      success = false;
      error = resp.error;
      docCount = 0;
      break;
    }
  }

  return {
    success,
    failures,
    docCount,
    ...(error ? { error } : {})
  };
}

export async function createIndexPattern(indexPatternName) {
  const indexPatterns = await indexPatternService.get();
  try {
    Object.assign(indexPatterns, {
      id: '',
      title: indexPatternName,
    });

    await indexPatterns.create(true);
    const id = await getIndexPatternId(indexPatternName);
    const indexPattern = await indexPatternService.get(id);
    return {
      success: true,
      id,
      fields: indexPattern.fields
    };
  } catch (error) {
    console.error(`Error creating index pattern: ${error}`);
    return {
      success: false,
      error,
    };
  }
}

async function getIndexPatternId(name) {
  const savedObjectsClient = chrome.getSavedObjectsClient();
  const savedObjectSearch =
    await savedObjectsClient.find({ type: 'index-pattern', perPage: 1000 });
  const indexPatternSavedObjects = savedObjectSearch.savedObjects;

  if (indexPatternSavedObjects) {
    const ip = indexPatternSavedObjects.find(i => i.attributes.title === name);
    return (ip !== undefined) ? ip.id : undefined;
  } else {
    return undefined;
  }
}

export async function getExistingIndices() {
  const basePath = chrome.addBasePath('/api');
  return await http({
    url: `${basePath}/index_management/indices`,
    method: 'GET',
  });
}

export async function getExistingIndexPatterns() {
  const savedObjectsClient = chrome.getSavedObjectsClient();
  return savedObjectsClient.find({
    type: 'index-pattern',
    fields: ['id', 'title', 'type', 'fields'],
    perPage: 10000
  }).then(({ savedObjects }) =>
    savedObjects.map(savedObject => savedObject.get('title'))
  );
}

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

export async function triggerIndexing(parsedFile, preIndexTransform, indexName, dataType) {
  if (!parsedFile) {
    throw('No file imported');
    return;
  }
  const index = await checkIndex(indexName);
  let id;

  // Perform any processing required on file prior to indexing
  const indexingDetails = getIndexingDetails(preIndexTransform, parsedFile, dataType);

  if (index.exists) {
    id = index.id;
  } else {
    const createdIndex = await writeToIndex({
      id: undefined,
      data: [],
      index: indexName,
      ...indexingDetails // Everything from the util file
    });
    id = createdIndex.id;
  }

  await populateIndex({
    id,
    data: parsedFile,
    index: indexName,
    ...indexingDetails,
    settings: {},
    mappings: {},
  });
  //create index pattern
  return await createIndexPattern('', indexName);
}

function getIndexingDetails(processor, parsedFile, dataType) {
  if (!processor) {
    throw('No processor defined');
    return;
  }
  let indexingDetails;
  if (typeof processor === 'object') { // Custom processor
    indexingDetails = processor.getIndexDetails(parsedFile);
  } else {
    switch(processor) {
      case 'geo':
        return getGeoJsonIndexingDetails(parsedFile, dataType);
        break;
      default:
        console.error(`No handling defined for processor: ${processor}`);
        return;
    }
  }
  return indexingDetails;
}

function writeToIndex(indexingDetails) {
  const paramString = (indexingDetails.id !== undefined) ? `?id=${indexingDetails.id}` : '';
  const {
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
    }
  });
}

async function populateIndex({ id, index, data, mappings, settings }) {
  if (!id || !index) {
    return {
      success: false,
      error: i18n.translate('xpack.ml.fileDatavisualizer.importView.noIdOrIndexSuppliedErrorMessage', {
        defaultMessage: 'no ID or index supplied'
      })
    };
  }

  const chunks = chunk(data, CHUNK_SIZE);

  let success = true;
  const failures = [];
  let error;
  let docCount = 0;

  for (let i = 0; i < chunks.length; i++) {
    const aggs = {
      id,
      index,
      data: chunks[i],
      settings,
      mappings,
      ingestPipeline: {}
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

  const result = {
    success,
    failures,
    docCount,
  };

  if (success) {
    console.log('yay!');
  } else {
    result.error = error;
  }

  return result;
}

async function createIndexPattern(indexPattern = '', index) {
  const indexPatterns = await indexPatternService.get();
  const indexPatternName = (indexPattern === '') ? index : indexPattern;
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
    console.error(error);
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


async function checkIndex(name) {
  const indices = await getExistingIndices();
  const existingIndex = indices.find(el => el.name === name);
  return existingIndex
    ? {
      exists: true,
      id: existingIndex.uuid
    }
    : {
      exists: false,
      id: null
    };
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

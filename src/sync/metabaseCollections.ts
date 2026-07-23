import { getNumber, getObject, getString } from "./http.js";

export function indexMetabaseCollections(
  collections: Record<string, unknown>[]
): Map<number, Record<string, unknown>> {
  return new Map(
    collections.flatMap((collection) => {
      const id = getNumber(collection.id);
      return id === undefined ? [] : [[id, collection] as const];
    })
  );
}

export function resolveMetabaseCollectionName(
  value: Record<string, unknown>,
  collectionsById: Map<number, Record<string, unknown>>
): string | undefined {
  const embeddedCollection = getObject(value.collection);
  const collectionId =
    getNumber(value.collection_id) ??
    getNumber(value.collectionId) ??
    getNumber(embeddedCollection?.id);
  return getString(embeddedCollection?.name) ??
    (collectionId === undefined ? undefined : getString(collectionsById.get(collectionId)?.name));
}

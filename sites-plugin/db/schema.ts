import {sqliteTable,text,integer,index} from 'drizzle-orm/sqlite-core';
export const papers=sqliteTable('papers',{
 id:text('id').primaryKey(),owner:text('owner').notNull(),title:text('title').notNull(),authors:text('authors').notNull().default(''),year:text('year').notNull().default(''),doi:text('doi').notNull().default(''),collection:text('collection').notNull().default(''),tags:text('tags').notNull().default(''),notes:text('notes').notNull().default(''),page:integer('page').notNull().default(1),zoom:integer('zoom').notNull().default(100),fileName:text('file_name'),fileKey:text('file_key'),size:integer('size').notNull().default(0),updatedAt:text('updated_at').notNull()
},t=>[index('papers_owner').on(t.owner)]);
export const pageContents=sqliteTable('page_contents',{
 id:text('id').primaryKey(),paperId:text('paper_id').notNull(),owner:text('owner').notNull(),fileVersion:text('file_version').notNull(),page:integer('page').notNull(),method:text('method').notNull(),confidence:integer('confidence').notNull(),width:integer('width').notNull(),height:integer('height').notNull(),segments:text('segments').notNull(),byteSize:integer('byte_size').notNull(),updatedAt:text('updated_at').notNull()
},t=>[index('pages_owner_paper').on(t.owner,t.paperId)]);
export const analysisArtifacts=sqliteTable('analysis_artifacts',{
 id:text('id').primaryKey(),paperId:text('paper_id').notNull(),owner:text('owner').notNull(),kind:text('kind').notNull(),language:text('language').notNull(),page:integer('page'),fileVersion:text('file_version').notNull(),requestHash:text('request_hash').notNull().default(''),sourceHash:text('source_hash').notNull(),sourcePages:text('source_pages').notNull(),content:text('content').notNull(),byteSize:integer('byte_size').notNull(),provenance:text('provenance').notNull(),createdAt:text('created_at').notNull()
},t=>[index('analysis_owner_paper').on(t.owner,t.paperId)]);
export const paperFigures=sqliteTable('paper_figures',{
 id:text('id').primaryKey(),paperId:text('paper_id').notNull(),owner:text('owner').notNull(),fileVersion:text('file_version').notNull(),page:integer('page').notNull(),label:text('label').notNull(),bbox:text('bbox').notNull(),width:integer('width').notNull(),height:integer('height').notNull(),objectKey:text('object_key').notNull(),byteSize:integer('byte_size').notNull(),createdAt:text('created_at').notNull()
},t=>[index('figures_owner_paper').on(t.owner,t.paperId)]);

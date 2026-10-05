'use strict';

const {
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  GraphQLError,
} = require('graphql');

const MAX_PAGE = 10;
const DEFAULT_PAGE = 2;

function page(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE) {
    throw new GraphQLError(`first must be an integer from 1 to ${MAX_PAGE}`, {
      extensions: { code: 'PAGE_OUT_OF_RANGE' },
    });
  }
  return value;
}

function count(field, resolver) {
  return (parent, args, context) => {
    context.resolverCalls += 1;
    context.byField[field] = (context.byField[field] || 0) + 1;
    return resolver(parent, args);
  };
}

function repeat(first, factory) {
  return Array.from({ length: page(first) }, (_, index) => factory(index + 1));
}

const Task = new GraphQLObjectType({
  name: 'Task',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID), resolve: count('Task.id', task => task.id) },
    label: { type: new GraphQLNonNull(GraphQLString), resolve: count('Task.label', task => `synthetic:${task.id}`) },
    children: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Task))),
      args: { first: { type: GraphQLInt, defaultValue: DEFAULT_PAGE } },
      resolve: count('Task.children', (task, args) => repeat(args.first, i => ({ id: `${task.id}.${i}` }))),
    },
  }),
});

const Project = new GraphQLObjectType({
  name: 'Project',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID), resolve: count('Project.id', project => project.id) },
    tasks: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Task))),
      args: { first: { type: GraphQLInt, defaultValue: DEFAULT_PAGE } },
      resolve: count('Project.tasks', (project, args) => repeat(args.first, i => ({ id: `${project.id}:task:${i}` }))),
    },
  }),
});

const Tenant = new GraphQLObjectType({
  name: 'Tenant',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID), resolve: count('Tenant.id', tenant => tenant.id) },
    projects: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Project))),
      args: { first: { type: GraphQLInt, defaultValue: DEFAULT_PAGE } },
      resolve: count('Tenant.projects', (tenant, args) => repeat(args.first, i => ({ id: `${tenant.id}:project:${i}` }))),
    },
  }),
});

const Query = new GraphQLObjectType({
  name: 'Query',
  fields: () => ({
    tenant: {
      type: new GraphQLNonNull(Tenant),
      args: { id: { type: new GraphQLNonNull(GraphQLID) } },
      resolve: count('Query.tenant', (_, args) => ({ id: args.id })),
    },
    health: {
      type: new GraphQLNonNull(GraphQLString),
      resolve: count('Query.health', () => 'synthetic-ok'),
    },
  }),
});

const schema = new GraphQLSchema({ query: Query });

module.exports = { schema, MAX_PAGE, DEFAULT_PAGE };

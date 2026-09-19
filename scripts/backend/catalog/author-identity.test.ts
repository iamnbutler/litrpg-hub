import { describe, expect, it } from 'vitest';
import { creditedAuthorKeys, sameAuthorCredits } from './author-identity.js';
import type { SeedSeries } from './types.js';

const single: SeedSeries = { id:'example',title:'Example',author:'Person One',authorAliases:['Person One','Pen Name'],aliases:[],genres:[],sources:[],priority:1 };
const collaboration: SeedSeries = { ...single,author:'Person One, Person Two',authorAliases:['Person One','Pen Name','Person Two'],
  authorIdentities:[{name:'Person One',aliases:['Pen Name']},{name:'Person Two',aliases:[]}] };

describe('credited author identity',()=>{
  it('treats repeated legal and pen-name credits as one person',()=>{
    expect(sameAuthorCredits(single,'Person One','Pen Name, Person One')).toBe(true);
    expect(creditedAuthorKeys(single,['Pen Name','Person One'])).toEqual(['personone']);
    expect(sameAuthorCredits(single,'Person One','Unrelated Person')).toBe(false);
  });
  it('preserves coauthor sets while accepting explicit aliases and different credit order',()=>{
    expect(sameAuthorCredits(collaboration,'Person One, Person Two','Person Two, Pen Name, Person One')).toBe(true);
    expect(sameAuthorCredits(collaboration,'Person One','Person Two')).toBe(false);
    expect(sameAuthorCredits(collaboration,'Person One, Person Two','Person One')).toBe(false);
  });
  it('does not guess which coauthor an otherwise unmapped pen name belongs to',()=>{
    const implicit={...collaboration,authorIdentities:undefined};
    expect(creditedAuthorKeys(implicit,'Person One, Person Two')).toEqual(['personone','persontwo']);
    expect(creditedAuthorKeys(implicit,'Pen Name')).toBeNull();
    expect(creditedAuthorKeys({...collaboration,authorIdentities:[{name:'Person One',aliases:['Pen Name']},{name:'Person Two',aliases:['Pen Name']}]},'Pen Name')).toBeNull();
  });
  it('excludes only reviewed publisher credits and never accepts an empty author set',()=>{
    const seed={...single,publisherCredits:['Example Press']};
    expect(sameAuthorCredits(seed,'Person One','Pen Name, Example Press')).toBe(true);
    expect(creditedAuthorKeys(seed,'Example Press')).toBeNull();
    expect(creditedAuthorKeys(seed,'')).toBeNull();
  });
});

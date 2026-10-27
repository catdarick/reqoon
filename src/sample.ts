// A small bundled spec used by "Try the sample" in the import dialog. Paths mirror the public
// Swagger Petstore v3 server so requests actually work; a few extras demo oneOf/allOf forms.
export const SAMPLE_SPEC = `openapi: 3.0.3
info:
  title: Petstore (sample)
  version: 1.0.0
  description: Sample API bundled with Reqoon.
servers:
  - url: https://petstore3.swagger.io/api/v3
tags:
  - name: pet
    description: Everything about your pets
  - name: store
    description: Access to Petstore orders
  - name: user
    description: Operations about users
paths:
  /pet:
    post:
      tags: [pet]
      summary: Add a new pet to the store
      operationId: addPet
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Pet' }
          application/x-www-form-urlencoded:
            schema: { $ref: '#/components/schemas/Pet' }
      responses:
        '200':
          description: Successful operation
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Pet' }
        '405': { description: Invalid input }
      security:
        - petstore_auth: [write:pets, read:pets]
    put:
      tags: [pet]
      summary: Update an existing pet
      operationId: updatePet
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Pet' }
      responses:
        '200': { description: Successful operation }
        '404': { description: Pet not found }
      security:
        - petstore_auth: [write:pets, read:pets]
  /pet/findByStatus:
    get:
      tags: [pet]
      summary: Finds pets by status
      operationId: findPetsByStatus
      parameters:
        - name: status
          in: query
          required: false
          description: Status values that need to be considered for filter
          schema:
            type: string
            default: available
            enum: [available, pending, sold]
      responses:
        '200':
          description: successful operation
          content:
            application/json:
              schema:
                type: array
                items: { $ref: '#/components/schemas/Pet' }
  /pet/findByTags:
    get:
      tags: [pet]
      summary: Finds pets by tags
      operationId: findPetsByTags
      parameters:
        - name: tags
          in: query
          required: false
          explode: true
          schema:
            type: array
            items: { type: string }
      responses:
        '200': { description: successful operation }
  /pet/{petId}:
    get:
      tags: [pet]
      summary: Find pet by ID
      operationId: getPetById
      parameters:
        - name: petId
          in: path
          required: true
          description: ID of pet to return
          example: 10
          schema: { type: integer, format: int64, minimum: 1 }
      responses:
        '200':
          description: successful operation
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Pet' }
        '404': { description: Pet not found }
      security:
        - api_key: []
        - petstore_auth: [read:pets]
    delete:
      tags: [pet]
      summary: Deletes a pet
      operationId: deletePet
      parameters:
        - name: api_key
          in: header
          required: false
          schema: { type: string }
        - name: petId
          in: path
          required: true
          schema: { type: integer, format: int64 }
      responses:
        '400': { description: Invalid pet value }
  /pet/{petId}/adoption:
    post:
      tags: [pet]
      summary: Start an adoption (demo of oneOf)
      operationId: adoptPet
      parameters:
        - name: petId
          in: path
          required: true
          schema: { type: integer }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/AdoptionRequest' }
      responses:
        '201': { description: Adoption started }
  /store/inventory:
    get:
      tags: [store]
      summary: Returns pet inventories by status
      operationId: getInventory
      responses:
        '200':
          description: successful operation
          content:
            application/json:
              schema:
                type: object
                additionalProperties: { type: integer, format: int32 }
      security:
        - api_key: []
  /store/order:
    post:
      tags: [store]
      summary: Place an order for a pet
      operationId: placeOrder
      requestBody:
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Order' }
      responses:
        '200':
          description: successful operation
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Order' }
  /store/order/{orderId}:
    get:
      tags: [store]
      summary: Find purchase order by ID
      operationId: getOrderById
      parameters:
        - name: orderId
          in: path
          required: true
          schema: { type: integer, format: int64 }
      responses:
        '200': { description: successful operation }
  /user:
    post:
      tags: [user]
      summary: Create user
      operationId: createUser
      requestBody:
        content:
          application/json:
            schema: { $ref: '#/components/schemas/User' }
      responses:
        default: { description: successful operation }
  /user/{username}:
    get:
      tags: [user]
      summary: Get user by user name
      operationId: getUserByName
      parameters:
        - name: username
          in: path
          required: true
          example: user1
          schema: { type: string }
      responses:
        '200': { description: successful operation }
components:
  schemas:
    Order:
      type: object
      properties:
        id: { type: integer, format: int64, example: 10 }
        petId: { type: integer, format: int64, example: 198772 }
        quantity: { type: integer, format: int32, example: 7, minimum: 1 }
        shipDate: { type: string, format: date-time }
        status:
          type: string
          description: Order Status
          example: approved
          enum: [placed, approved, delivered]
        complete: { type: boolean }
    Category:
      type: object
      properties:
        id: { type: integer, format: int64, example: 1 }
        name: { type: string, example: Dogs }
    User:
      type: object
      required: [username, email]
      properties:
        id: { type: integer, format: int64, example: 10 }
        username: { type: string, example: theUser, minLength: 3 }
        firstName: { type: string, example: John }
        lastName: { type: string, example: James }
        email: { type: string, format: email, example: john@email.com }
        password: { type: string, writeOnly: true }
        phone: { type: string, nullable: true }
        userStatus: { type: integer, description: User Status, format: int32 }
    Tag:
      type: object
      properties:
        id: { type: integer, format: int64 }
        name: { type: string }
    Pet:
      required: [name, photoUrls]
      type: object
      properties:
        id: { type: integer, format: int64, example: 10, readOnly: true }
        name: { type: string, example: doggie }
        category: { $ref: '#/components/schemas/Category' }
        photoUrls:
          type: array
          minItems: 1
          items: { type: string, format: uri }
        tags:
          type: array
          items: { $ref: '#/components/schemas/Tag' }
        status:
          type: string
          description: pet status in the store
          enum: [available, pending, sold]
    Address:
      type: object
      required: [street, city]
      properties:
        street: { type: string }
        city: { type: string }
        zip: { type: string, pattern: '^[0-9]{5}$' }
    Person:
      type: object
      required: [kind, fullName]
      properties:
        kind: { type: string, enum: [person] }
        fullName: { type: string }
        address: { $ref: '#/components/schemas/Address' }
    Organization:
      type: object
      required: [kind, orgName, contacts]
      properties:
        kind: { type: string, enum: [organization] }
        orgName: { type: string }
        contacts:
          type: array
          items:
            allOf:
              - $ref: '#/components/schemas/Person'
              - type: object
                properties:
                  role: { type: string }
    AdoptionRequest:
      type: object
      required: [adopter, startDate]
      properties:
        adopter:
          oneOf:
            - $ref: '#/components/schemas/Person'
            - $ref: '#/components/schemas/Organization'
          discriminator:
            propertyName: kind
            mapping:
              person: '#/components/schemas/Person'
              organization: '#/components/schemas/Organization'
        startDate: { type: string, format: date }
        notes: { type: string, maxLength: 500 }
        metadata:
          type: object
          additionalProperties: { type: string }
  securitySchemes:
    petstore_auth:
      type: oauth2
      flows:
        implicit:
          authorizationUrl: https://petstore3.swagger.io/oauth/authorize
          scopes:
            write:pets: modify pets in your account
            read:pets: read your pets
    api_key:
      type: apiKey
      name: api_key
      in: header
`;

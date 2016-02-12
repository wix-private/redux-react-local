import React, {PropTypes, Component} from 'react';
import { Provider, connect } from 'react-redux';
import createSagaMiddleware from 'redux-saga';
import optimist from 'redux-optimist';
// import ensureFSAMiddleware from '@meadow/redux-ensure-fsa';

import { batchedSubscribe } from 'redux-batched-subscribe';
import { unstable_batchedUpdates as batchedUpdates } from 'react-dom';

import {createStore, combineReducers, applyMiddleware, compose} from 'redux';


function log(...args){
  console.log(...args, this);
  return this;
}


export class Root extends Component{
  static propTypes = {
    middleware: PropTypes.array,
    reducers: PropTypes.object
  };
  static defaultProps = {
    middleware: [],
    reducers: {}
  };
  sagas = createSagaMiddleware();
  store = createStore(optimist(combineReducers({
    // reducers
    ...this.props.reducers,
    local: localReducer
  })), {
    // initial state
  }, compose(applyMiddleware(
    // middleware
    ...this.props.middleware,
    this.sagas,
    // ensureFSAMiddleware // todo - only for development
  ), batchedSubscribe(batchedUpdates)));
  static childContextTypes = {
    sagas: PropTypes.func
  };
  getChildContext(){
    return {
      sagas: this.sagas
    };
  }
  render(){
    return <Provider store={this.store}>
      {this.props.children}
    </Provider>;
  }
}


const identity = x => x;

export function localReducer(state = {registered: {}}, action){
  let {payload, type, meta} = action;
  // this is the test sequence -
  // - local.register
  // - local.swap
  // - then reduce on all local keys
  // - local.unmount

  if (type === 'local.register'){
    if (state.registered[payload.ident] && state.registered[payload.ident].reducer !== identity){
      // todo - throw, but not when hot reloading
      console.warn(`${payload.ident} already exists`);
    }
    if (payload.ident === 'registered'){
      throw new Error('cannot have an ident named `registered`, sorry!');
    }
    state = {
        ...state,
        [payload.ident] : state[payload.ident] !== undefined ? state[payload.ident] : payload.initial, // this way we can 'persist' across unmounts
        registered : {
          ...state.registered,
          [payload.ident]: {
            reducer: payload.reducer
          }
        }
      };
  }

  if (type === 'local.swap'){
    // ???
    return state;
  }

  // update all local keys
  let ret = {registered: state.registered}, changed = false;
  Object.keys(state.registered).forEach(key => {
    let a = action;

    // if this originated from the same key, then add me: true
    if (meta && meta.local && key === meta.ident){
      a = {
        ...a,
        me: true
      };
    }

    // reduce
    let computed = state.registered[key].reducer(state[key], a);
    if (computed === undefined){
      console.warn(`did you forget to return state from the ${key} reducer?`);
    }

    if (computed !== state[key]){
      changed = true;
    }
    ret[key] = computed;
  });


  if (changed) {
    // prevent rerenders if nothing's changed
    state = ret;
  }

  if (type === 'local.unmount'){
    state = {
      ...state,
      // we can leave the data in place
      [payload.ident] : payload.persist ? state[payload.ident] : undefined,
      registered : {
        ...state.registered,
        [payload.ident]: {
          reducer: identity // signals that this is unmounted
        }
      }
    };
  }

  return state;

}

export function local({
  ident, // string / ƒ(props)
  initial = {}, // object / ƒ(props)
  reducer = x => x, // ƒ(state, action) => state
  saga, // ƒ*(getState, {$, ident, getState})
  persist = true // experimental - can swap out state on unmount
} = {}){
  if (!ident){
    throw new Error('cannot annotate with @local without an ident');
  }

  return function(Target){

    function getId(props){
      if (typeof ident === 'string'){
        return ident;
      }
      return ident(props);
    }

    function getInitial(props){
      if (typeof initial !== 'function'){
        return initial;
      }
      return initial(props);
    }

    @connect((state, props) => ({
      local: state.local[getId(props)]
    }))
    class ReduxReactLocal extends Component{
      static displayName = 'local:' + (Target.displayName || Target.name);
      static contextTypes = {
        sagas: PropTypes.func
      };

      state = {
        id: getId(this.props),
        value: getInitial(this.props)
      };

      componentWillMount(){
        this.props.dispatch({
          type: 'local.register',
          payload: {
            ident: this.state.id,
            reducer,
            initial: this.state.value
          }
        });
      }

      componentDidMount(){
        if (saga){
          this.runningSaga = this.context.sagas.run(saga, {
            $: this.$,
            ident: this.state.id,
            getState: () => this.state.value
          });
        }
      }

      componentWillReceiveProps(next){
        let id = getId(next);

        if (id !== this.state.id){
          this.props.dispatch({
            type: 'local.swap',
            payload: {
              ident: this.state.id,
              next: id,
              initial: getInitial(next)
            }
          });

        }
        this.setState({ id, value: next.local });
      }

      $ = (type, payload, more) => {
        if (typeof type !== 'string'){
          throw new Error('invalid event');
        }
        // 'localize' an event. super conveninent for actions 'local' to this component
        let action =  {
          type: `${this.state.id}:${type}`,
          payload,
          meta: {
            // this is just to be faster when reducing
            ident: this.state.id,
            type,
            local: true
          }
        };
        if (more){
          Object.assign(action, more);
        }
        return action;
      };

      render(){
        return React.createElement(Target, {
          ...this.props,
          $: this.$,
          ident: this.state.id,
          dispatch: this.props.dispatch,
          state: this.state.value,
        }, this.props.children);
      }

      componentWillUnmount(){
        this.props.dispatch({
          type: 'local.unmount',
          payload: {
            ident: this.state.id,
            persist
          }
        });
        if (this.runningSaga){
          this.runningSaga.cancel();
          delete this.runningSaga;
        }
      }
    }

    return ReduxReactLocal;
  };
}

